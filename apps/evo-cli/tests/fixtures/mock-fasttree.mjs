#!/usr/bin/env node
let fasta = "";
for await (const chunk of process.stdin) fasta += chunk;
const delay = Math.max(0, Number(process.env.MOCK_FASTTREE_DELAY_MS ?? 0));
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
const names = [...fasta.matchAll(/^>(\S+)/gmu)].map((match) => match[1]);
const leaves = names.map((name) => `${name}:0.1`);
while (leaves.length > 3) leaves.splice(0, 2, `(${leaves[0]},${leaves[1]}):0.05`);
process.stdout.write(`(${leaves.join(",")});\n`);
process.stderr.write("GTR Frequencies: 0.25 0.25 0.25 0.25\n");
process.stderr.write("GTR rates(ac ag at cg ct gt) 1 2 1 1 2 1\n");
process.stderr.write("Gamma(20) LogLk = -12.5 alpha = 1.0\n");
