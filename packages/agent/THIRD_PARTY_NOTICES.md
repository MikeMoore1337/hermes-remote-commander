# Third-party notices

The MIT license and attribution for Better Remote Commander and the derived
Desktop Commander MCP code are in `LICENSE` and `NOTICE`. Dependencies retain
their own copyright notices and licenses in their installed package directories.

This repository's pinned lockfile resolves `sharp` 0.35.5, which is Apache-2.0.
Its optional prebuilt native dependencies include:

- `@img/sharp-win32-x64` 0.35.5: Apache-2.0 AND LGPL-3.0-or-later.
- `@img/sharp-libvips-linux-x64` 1.3.4: LGPL-3.0-or-later.
- `@img/sharp-libvips-linuxmusl-x64` 1.3.4: LGPL-3.0-or-later.

The native packages' README and `versions.json` list the bundled libraries and
their licenses. The [sharp-libvips v1.3.4 release](https://github.com/lovell/sharp-libvips/releases/tag/v1.3.4)
identifies the component versions, including libvips 8.18.7, and the tagged
repository contains its build recipes. Copies of the GNU GPL v3 and LGPL v3
are provided in `licenses/`. Installations outside this workspace may resolve
other transitive versions; inspect the artifacts actually being distributed.

JSZip 3.10.1 and PizZip 3.2.0 each offer an MIT alternative; this distribution
selects that alternative. Other dependencies retain the licenses they declare.

Before distributing a binary or image containing LGPL libraries, verify the
exact platform artifacts, complete corresponding sources, notices and the
applicable relinking or shared-library conditions. This notice does not certify
that a particular binary distribution satisfies those obligations. The fork
repository link alone does not identify the corresponding source for a binary;
each release must identify and retain its exact source and build inputs.
