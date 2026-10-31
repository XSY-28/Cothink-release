# Pi SDK update notices (2026-10-24)

Selected npm `pi-subagents@0.84.0` (MIT, Nico Bailon) receives the disclosed CoThink `native-host-admission-v2` candidate patch. This extends the previous foreground timeout-zero patch with a public host admission/lifecycle module, declarations, and source/bundle call sites. Upstream integrity, original/patched hashes, added-file hashes, and exact replacements are recorded in `vendor/pi-patches/pi-subagents-0.84.0-foreground-unlimited-v1.json`. The filename preserves the original patch lineage; the manifest revision is authoritative. See [host contract](docs/pi-subagents-host-contract.md) for implemented boundaries and outstanding native route integration. This is not an upstream release.

The CoThink preview uses Pi v1.4.0 from https://github.com/earendil-works/pi/tree/v1.4.0 (MIT), including coding-agent, agent-core, pi-ai, pi-tui and their declared dependencies. The locally built coding-agent package includes the upstream LICENSE. Optional host UI hooks and secret rendering are documented in vendor/pi-patches; upstream default paths remain available.

The pinned OpenAI Node SDK 7.19.0 (Apache-2.0) and Anthropic TypeScript SDK 0.129.0 (MIT) have an explicit timeout-zero timer patch. Their packaged source and license files are retained in the local artifacts. Hashes, origin, build and patches are recorded in vendor/pi-patches/manifest.json and source.json. Transitive license notices remain in dependency packages. CoThink original code and its bundled agent-sync core are licensed under MIT; see LICENSE. Third-party components retain their own licenses.

The local Pi coding-agent revision `1.4.0-cothink.2` uses the SDK's existing shared virtual modules in Node as well as embedded runtimes. Exact root/legacy aliases retain the host SDK objects; other public subpaths use package exports. The pinned MIT Jiti 2.7.0 is packaged as `2.7.0-cothink.1`: one condition makes `moduleCache:false` also transpile asynchronous ESM, so `.js` entrypoints and relative modules reload together while top-level await is retained. The cached mode is unchanged. Original/patched source hashes and the exact unique replacement are recorded in `vendor/pi-patches/source.json`; built artifact hashes are in `manifest.json`. The Jiti package retains its MIT LICENSE and upstream package/source metadata. This is a consumer compatibility patch, not an upstream release or a second plugin loader.

The following notices from the earlier terminal integration are retained.

# Third-party notices

The terminal interface depends on @earendil-works/pi-tui 1.4.0 (MIT), get-east-asian-width 1.6.0 (MIT), and marked 18.0.11 (MIT, with the additional Markdown notice below). These are included in the bundled production dependencies; their notices are retained here and in the dependency packages where supplied. The root LICENSE applies to CoThink original code; the following third-party notices remain applicable.

## @earendil-works/pi-tui 1.4.0

Source: https://github.com/earendil-works/pi/blob/v1.4.0/LICENSE

The license is retained from the pinned upstream v1.4.0 source archive and included in the locally rebuilt package.

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## get-east-asian-width 1.6.0

MIT License

Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.


## marked 18.0.11

# License information

## Contribution License Agreement

If you contribute code to this project, you are implicitly allowing your code
to be distributed under the MIT license. You are also implicitly verifying that
all code is your original work. `</legalese>`

## Marked

Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/)
Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## Markdown

Copyright © 2004, John Gruber
http://daringfireball.net/
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
* Neither the name “Markdown” nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

This software is provided by the copyright holders and contributors “as is” and any express or implied warranties, including, but not limited to, the implied warranties of merchantability and fitness for a particular purpose are disclaimed. In no event shall the copyright owner or contributors be liable for any direct, indirect, incidental, special, exemplary, or consequential damages (including, but not limited to, procurement of substitute goods or services; loss of use, data, or profits; or business interruption) however caused and on any theory of liability, whether in contract, strict liability, or tort (including negligence or otherwise) arising in any way out of the use of this software, even if advised of the possibility of such damage.


## GUI browser distribution (0.8.0-gui.1)

The built React/Markdown/KaTeX frontend and local KaTeX fonts are accompanied by [gui/THIRD_PARTY_NOTICES.txt](gui/THIRD_PARTY_NOTICES.txt). It retains the actual installed LICENSE/NOTICE files for the full declared runtime dependency closure (125 packages), with the omitted remark-math/rehype-katex monorepo license retrieved from the exact npm gitHead noted there. Build tools and test libraries are development dependencies. Pi SDK provenance and hashes are maintained separately in vendor/pi-patches.


## semver 7.8.5

Direct bundled dependency for shared CoThink version comparison; no Pi private implementation is copied.

The ISC License

Copyright (c) Isaac Z. Schlueter and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

The disclosed pi-subagents native-host-admission-v2 transform also patches the original detached bootstrap and spawn boundaries. Authentication precedes managed bootstrap writes; the original process, status and stop protocol remain. Exact source/bundle preimages and postimages remain in the compatibility manifest. CoThink supplies its task-local transport and scoped tools; this is not an upstream API guarantee.

The same disclosed transform adds owner-attested Herdr placement/SSH options, observed startup readiness, and managed runtime receipts around the original native bridge. Remote runtime selection uses the pinned package's official unbundled `dist/cli.js` with the existing patched provider dependencies; it does not substitute a model loop. Herdr TUI 0.9.5 (Apache-2.0) is an external, explicitly configured prerequisite, not bundled in this package.
