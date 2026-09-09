# Install scripts

Build standalone `uassist` / `uassist-server` binaries and put them on your
PATH, so `uassist` works from any directory without `bun run` or this
checkout in scope. Bun is required to *build* them; the resulting binaries
are self-contained and don't need Bun installed to run afterward.

- **macOS / Linux:** `./scripts/install.sh`
  Installs to `~/.uassist/bin` (override with `UASSIST_INSTALL_DIR`), and
  adds it to `PATH` in `~/.zshrc` or `~/.bashrc` if it isn't already there.
- **Windows:** `powershell -ExecutionPolicy Bypass -File scripts\install.ps1`
  Installs to `%LOCALAPPDATA%\uassist\bin` (override with
  `$env:UASSIST_INSTALL_DIR`), and adds it to your user `PATH`.

`uassist` and `uassist-server` must stay in the same directory —
`uassist start` locates `uassist-server` next to its own executable path,
not by searching `PATH`.

To rebuild after making changes, just re-run the script — it always builds
fresh from source. To uninstall, delete the install directory and remove the
PATH entry the script added.
