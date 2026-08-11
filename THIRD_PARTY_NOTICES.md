# Third-party notices

## MurrellGroup/WebWidgets

The following vendored files derive from [MurrellGroup/WebWidgets](https://github.com/MurrellGroup/WebWidgets), revision `cbcd02719dd0a5f1f05d3127666f00e8579f2423`:

- `alivibe.html`
- `phylotagger.html`
- `nw.js`
- `phylotools.js`
- `frameclean.js`

The HTML files contain a small EvoOnline `postMessage` bridge and alivibe's same-repository script references have been made relative. The upstream code is MIT licensed; its license is preserved at `apps/web/public/widgets/LICENSE`.

alivibe loads Aioli/bioWASM for Kalign and FastTree. Those runtime packages retain their own upstream licenses and notices.

## DifFUBAR WebGPU implementation

`models/diffubar` incorporates the previously supplied optimized DifFUBAR TypeScript/AssemblyScript implementation under its included MIT license. Its README and parity documentation are preserved in that package.

## CodonMolecularEvolution.jl FUBAR behavior

`models/fubar` independently implements the fixed-grid and DirichletFUBAR behavior documented by [MurrellGroup/CodonMolecularEvolution.jl](https://github.com/MurrellGroup/CodonMolecularEvolution.jl), which is MIT licensed. It reuses this repository's own optimized MG94 kernels; no Julia runtime or HyPhy FUBAR code is bundled.

## Experimental FAME and FLAVOR behavior

`models/bame` independently ports the FAME and FLAVOR model definitions from the [MurrellGroup/CodonMolecularEvolution.jl `MixtureModels` branch](https://github.com/MurrellGroup/CodonMolecularEvolution.jl/tree/MixtureModels), pinned to commit `4c65c984b2e7ad121f5e28298de69bdc0dd427b7`. CodonMolecularEvolution.jl is MIT licensed. EvoOnline uses original TypeScript/AssemblyScript Gamma, quadrature, posterior, worker, visualization, and fused MG94 branch-mixture code; it bundles neither Julia nor the upstream plotting stack.

## BS-REL method and MolecularEvolution.jl message semantics

`models/bsrel` is an independent TypeScript/AssemblyScript implementation of the fixed three-rate BS-REL method described by Kosakovsky Pond et al. (2011). It does not bundle HyPhy, aBS-REL, or any AIC-based adaptive model-selection code. Its root-to-tip outside-message organization follows the public `felsenstein_down!` semantics documented by [MurrellGroup/MolecularEvolution.jl](https://github.com/MurrellGroup/MolecularEvolution.jl), which is MIT licensed; the SIMD kernels and optimizer in this repository are original code.

## Mol*

The optional structure-mapping panel lazy-loads the pinned standalone [Mol*](https://github.com/molstar/molstar) 5.11.0 viewer from jsDelivr. Mol* is MIT licensed. It is not installed as an npm dependency or included in EvoOnline's application bundle; the runtime is requested only after the user maps a structure.

## Normalized amino-acid glyph outlines

The structure profile-alignment display contains normalized vector outlines derived from DejaVu Sans Bold. DejaVu changes are public domain; the original Bitstream Vera outlines carry the following notice and permission:

> Copyright (c) 2003 by Bitstream, Inc. All Rights Reserved. Bitstream Vera is a trademark of Bitstream, Inc.
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of the fonts accompanying this license ("Fonts") and associated documentation files (the "Font Software"), to reproduce and distribute the Font Software, including without limitation the rights to use, copy, merge, publish, distribute, and/or sell copies of the Font Software, and to permit persons to whom the Font Software is furnished to do so, subject to the following conditions:
>
> The above copyright and trademark notices and this permission notice shall be included in all copies of one or more of the Font Software typefaces.
>
> The Font Software may be modified, altered, or added to, and in particular the designs of glyphs or characters in the Fonts may be modified and additional glyphs or characters may be added to the Fonts, only if the fonts are renamed to names not containing either the words "Bitstream" or the word "Vera".
>
> This License becomes null and void to the extent applicable to Fonts or Font Software that has been modified and is distributed under the "Bitstream Vera" names.
>
> The Font Software may be sold as part of a larger software package but no copy of one or more of the Font Software typefaces may be sold by itself.
>
> THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL BITSTREAM OR THE GNOME FOUNDATION BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER DEALINGS IN THE FONT SOFTWARE.
>
> Except as contained in this notice, the names of Gnome, the Gnome Foundation, and Bitstream Inc. shall not be used in advertising or otherwise to promote the sale, use, or other dealings in the Font Software without prior written authorization from the Gnome Foundation or Bitstream Inc., respectively.
