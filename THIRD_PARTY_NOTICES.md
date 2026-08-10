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
