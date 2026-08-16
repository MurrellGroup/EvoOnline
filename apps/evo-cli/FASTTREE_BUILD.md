# FastTree 2.1.11 release-bundle build information

The adjacent `FastTree`/`FastTree.exe` program in an `evo-cli` release archive is compiled without source modifications from:

- Repository: <https://github.com/morgannprice/fasttree>
- Commit: `29c5e62fbcd93230ee325f9c6a17b81f00e3c72a` (`v2.2.0`)
- Source: `old/FastTree-2.1.11.c`
- Source SHA-256: `9026ae550307374be92913d3098f8d44187d30bea07902b9dcbfb123eaa2050f`

Unix build command:

```sh
cc -DUSE_DOUBLE -O3 -finline-functions -funroll-loops -Wall \
  -o FastTree FastTree-2.1.11.c -lm
```

Windows x86-64 is built with MinGW-w64 GCC using the same options and `-o FastTree.exe`. The complete reproducible platform matrix is in `.github/workflows/release-evo-cli.yml` in the EvoOnline source project.

FastTree's source notice permits GPL version 2 or, at the recipient's option, any later version. The release bundle conveys it under GPL-3.0 and includes `FastTree-LICENSE` plus this exact source file. EvoOnline does not modify or link FastTree; it invokes the separate executable through ordinary standard input/output and files.
