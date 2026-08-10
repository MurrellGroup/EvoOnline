import { DifFUBARError, type ParsedTree, type TreeNode } from "../types.js";

export interface NormalizedTreeText {
  readonly newick: string;
  readonly inferredTags: readonly string[];
}

export function normalizeDifFubarTreeText(input: string): NormalizedTreeText {
  let text = input.replace(/^\uFEFF/, "").trim();
  if (/^#NEXUS/i.test(text)) {
    const treeMatch = text.match(/\btree\s+[^=]*=\s*(?:\[&R\]\s*)?([\s\S]*?;)/i);
    if (!treeMatch?.[1]) throw new DifFUBARError("NO_NEXUS_TREE", "No tree declaration was found in the NEXUS input.");
    text = treeMatch[1];
  }

  const colorPattern = /\[&!color=(#[0-9a-fA-F]+)\]/g;
  const colors: string[] = [];
  for (const match of text.matchAll(colorPattern)) {
    const color = match[1]!;
    if (!colors.includes(color)) colors.push(color);
  }
  if (colors.length > 0) {
    text = text.replace(colorPattern, (_whole, color: string) => `{G${colors.indexOf(color) + 1}}`);
  }
  // Other Newick/NEXUS comments do not affect the branch-class semantics used by difFUBAR.
  text = text.replaceAll(/\[[^\]]*\]/g, "");
  const inferredTags = [...new Set([...text.matchAll(/\{[^}]+\}/g)].map((match) => match[0]))].sort();
  return { newick: text, inferredTags };
}

class NewickParser {
  private position = 0;
  private nextId = 0;

  constructor(private readonly text: string) {}

  parse(): TreeNode {
    this.skipWhitespace();
    const root = this.parseSubtree(null);
    this.skipWhitespace();
    if (this.peek() === ";") this.position += 1;
    this.skipWhitespace();
    if (this.position !== this.text.length) {
      throw new DifFUBARError("INVALID_NEWICK", `Unexpected token near position ${this.position}.`);
    }
    root.branchLength = 0;
    return root;
  }

  private parseSubtree(parent: TreeNode | null): TreeNode {
    this.skipWhitespace();
    const node: TreeNode = {
      id: this.nextId++,
      name: "",
      branchLength: 0,
      branchClass: -1,
      parent,
      children: [],
      tipIndex: -1,
    };

    if (this.peek() === "(") {
      this.position += 1;
      while (true) {
        node.children.push(this.parseSubtree(node));
        this.skipWhitespace();
        const token = this.peek();
        if (token === ",") {
          this.position += 1;
          continue;
        }
        if (token !== ")") throw new DifFUBARError("INVALID_NEWICK", `Expected ',' or ')' near position ${this.position}.`);
        this.position += 1;
        break;
      }
      node.name = this.parseOptionalLabel();
    } else {
      node.name = this.parseRequiredLabel();
    }

    this.skipWhitespace();
    if (this.peek() === ":") {
      this.position += 1;
      const token = this.parseNumberToken();
      const length = Number(token);
      if (!Number.isFinite(length) || length < 0) {
        throw new DifFUBARError("INVALID_BRANCH_LENGTH", `Invalid branch length '${token}'.`);
      }
      node.branchLength = length;
    }
    return node;
  }

  private parseOptionalLabel(): string {
    this.skipWhitespace();
    return [":", ",", ")", ";", ""].includes(this.peek()) ? "" : this.parseLabel();
  }

  private parseRequiredLabel(): string {
    const label = this.parseLabel();
    if (label.length === 0) throw new DifFUBARError("UNNAMED_TIP", `A tree tip near position ${this.position} has no name.`);
    return label;
  }

  private parseLabel(): string {
    this.skipWhitespace();
    if (this.peek() === "'") {
      this.position += 1;
      let result = "";
      while (this.position < this.text.length) {
        const character = this.text[this.position++]!;
        if (character === "'") {
          if (this.peek() === "'") {
            result += "'";
            this.position += 1;
          } else {
            return result;
          }
        } else {
          result += character;
        }
      }
      throw new DifFUBARError("INVALID_NEWICK", "Unterminated quoted Newick label.");
    }
    const start = this.position;
    while (this.position < this.text.length && !/[\s(),:;]/.test(this.text[this.position]!)) this.position += 1;
    return this.text.slice(start, this.position);
  }

  private parseNumberToken(): string {
    this.skipWhitespace();
    const start = this.position;
    while (this.position < this.text.length && !/[\s(),;]/.test(this.text[this.position]!)) this.position += 1;
    if (start === this.position) throw new DifFUBARError("INVALID_NEWICK", `Missing branch length near position ${this.position}.`);
    return this.text.slice(start, this.position);
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.peek())) this.position += 1;
  }

  private peek(): string {
    return this.text[this.position] ?? "";
  }
}

export function parseTaggedNewick(input: string, requestedTags?: readonly string[]): ParsedTree {
  const normalized = normalizeDifFubarTreeText(input);
  const tags = [...(requestedTags ?? normalized.inferredTags)].sort();
  if (tags.length !== 2) {
    throw new DifFUBARError(
      "TAG_COUNT",
      `difFUBAR compares exactly two foreground tags; found ${tags.length}. Pass the two tags explicitly if needed.`,
    );
  }
  const root = new NewickParser(normalized.newick).parse();
  const nodes: TreeNode[] = [];
  const tips: TreeNode[] = [];
  let hasBackground = false;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    nodes.push(node);
    const rawName = node.name;
    let branchClass: number = tags.length;
    for (let i = 0; i < tags.length; i += 1) {
      if (rawName.includes(tags[i]!)) branchClass = i;
    }
    node.branchClass = branchClass;
    node.name = tags.reduce((name, tag) => name.replaceAll(tag, ""), rawName);
    if (node !== root && branchClass === tags.length) hasBackground = true;
    if (node.children.length === 0) {
      node.tipIndex = tips.length;
      tips.push(node);
    } else {
      for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push(node.children[i]!);
    }
  }
  if (tips.length < 2) throw new DifFUBARError("TOO_FEW_TIPS", "The tree must contain at least two tips.");
  const classCount = tags.length + (hasBackground ? 1 : 0);
  return { root, nodes, tips, classCount, hasBackground, tags };
}
