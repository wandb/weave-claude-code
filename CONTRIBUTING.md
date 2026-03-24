# Contributing to weave-claude-plugin

Until further notice, this project does not accept external contributions as of March 2026.

## License headers
<!--- REUSE-IgnoreStart -->

Source code should contain an SPDX-style license header, reflecting:
- Year & Copyright owner
- SPDX License identifier `SPDX-License-Identifier: MIT`
- Package Name: `SPDX-PackageName: weave-claude-plugin`

This can be partially automated with [FSFe REUSE](https://reuse.software/dev/#tool)
```shell
reuse annotate --license MIT --copyright 'CoreWeave, Inc.'  --year 2026 --template default_template --skip-existing $FILE
```

Blindly adding the headers to every file without review risks assigning the
wrong copyright owner! You should endeavor to understand who owns
contributions!

- The weave-claude-plugin source is licensed under the MIT license to protect the
  rights of all parties.

Licensing state & SPDX bill-of-materials (BOM) can be valiated & generated with:
```shell
reuse lint
reuse spdx
```

<!--- REUSE-IgnoreEnd -->