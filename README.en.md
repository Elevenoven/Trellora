# Trellora

A local-first Markdown notes and knowledge application for Windows, with editing, material libraries, AI questions, and long-term memory.

## Downloads

Version **1.0.1**, Windows x64.

- [Portable EXE](https://github.com/Elevenoven/Trellora/releases/download/v1.0.1/Trellora-1.0.1-portable-x64.exe)
- [Installer EXE](https://github.com/Elevenoven/Trellora/releases/download/v1.0.1/Trellora-1.0.1-setup-x64.exe)
- [GitHub Releases](https://github.com/Elevenoven/Trellora/releases)

Exit before replacing the portable EXE. Keep your workspace, note libraries, and material libraries. Packaged launches check this repository's latest stable Release; downloads open in your browser. Python is bundled. Configure Ollama or a remote model provider when needed. Checksums are in [SHA256SUMS.txt](downloads/SHA256SUMS.txt).

## Run from source

Use Windows x64, Node.js 22 or 24, and pnpm.

```powershell
pnpm install --frozen-lockfile
pnpm run rebuild:native
pnpm dev
```

For Windows packages, install a Windows x64 CPython and the slim Worker dependencies:

```powershell
py -3 -m pip install --target pipeline-python/.deps -r pipeline-python/requirements.lock
pnpm build
pnpm run release:manifest
```

Packages are written to `trellora/`.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for project attribution. Third-party components retain their own licenses.
