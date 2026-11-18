# Nix package

This fork provides a Nix flake for `x86_64-linux` only. It exports
`packages.x86_64-linux.ovis` and the same package as `packages.x86_64-linux.default`,
`checks.x86_64-linux.ovis`, and `overlays.default`, which provides `pkgs.ovis`.
It does not provide a service module or claim inclusion in nixpkgs.

## Build and run

From the flake checkout, build with `nix build .#ovis` or run with
`nix run .# -- serve`. The executable is `bin/ovis-server`. An existing herdr or
hc daemon must be available to the same user on the same socket.

This fork requires a loopback host and Cloudflare Access configuration. Set
`OVIS_CF_ACCESS_TEAM_DOMAIN`, `OVIS_CF_ACCESS_AUD`, `OVIS_CF_ACCESS_ALLOWED_EMAILS`,
and `OVIS_PUBLIC_ORIGIN`; the public origin must use HTTPS. Route that public
host through Cloudflare Access to the loopback listener, for example using
Cloudflare Tunnel, and open the protected public HTTPS URL. Setting the public
origin alone does not set up ingress. A direct request to the loopback listener
without `Cf-Access-Jwt-Assertion` receives 401. Set `OVIS_STATE_DIR` to a
location outside the Nix store.

The package builds the client with the frozen `bun.lock` and patches and builds
the Rust PTY from the committed `Cargo.lock`. It runs the server from source with
bundled Bun and the Rust PTY, but does not bundle or guarantee Node or the Node
`node-pty` fallback. Do not set `OVIS_PTY_SIDECAR=node` for this package unless
you separately supply a tested, working fallback. If the Rust PTY is unavailable
and Node is absent, herdr panes are mirrored and explicit PTY requests fail with
a clear no-PTY-host error. Herdr-core terminal attach instead streams over hc and
needs no PTY host.

The wrapper preserves existing PATH choices and
appends coreutils, git, gh, openssh and tar. Its `extraPackages` override defaults
to an empty list; a consumer can supply runtime CLIs, for example with
`extraPackages = [ herdrCore ];` when `herdrCore` is defined by that consumer.
Serving herdr terminals requires the herdr CLI on the service PATH, such as via
`extraPackages`, or an absolute path in `OVIS_HERDR_BIN`; socket access alone is
not enough. For hc discovery, alternatively set `OVIS_HC_BIN` explicitly.
For herdr-core, also set `OVIS_RUNTIME=herdr-core`; the executable override alone
only tells Ovis where to find hc. Keep the existing `HC_SESSION` / `HC_SOCKET`
configuration for that daemon. `HERDR_SOCKET` selects a herdr socket, not an hc socket.

Running `serve` does not automatically update Ovis. Nix owns package updates.

## Dotfiles integration and updates

Add the flake input as
`ovis = { url = "github:reta-ygs/ovis/main"; inputs.nixpkgs.follows = "nixpkgs"; };`.
Select the package with `inputs.ovis.packages.${pkgs.stdenv.hostPlatform.system}.ovis`,
or use the flake's default overlay. The input tracks the fork's `main` branch,
but the dotfiles `flake.lock` pins the actual commit. Run `nix flake update ovis`
to change that pin. Do not tag-track the devswha upstream in place of this
hardening fork.

Renovate's standard Nix manager and lock file maintenance can update the branch
input in `flake.lock`. For example, merge `{"nix":{"enabled":true},"lockFileMaintenance":{"enabled":true}}`
into the existing Renovate configuration rather than overwriting it. Updated
locks take effect only through the existing dotfiles deployment CI or timer.
Restarting a running Ovis disconnects browsers and must be approved; never restart
hc or herdr as part of an Ovis package upgrade.

## Maintenance

The selected Bun must meet or exceed the `packageManager` requirement in
`package.json`. When `bun.lock` or patches change, refresh the Bun dependency hash
in `nix/package.nix`; when `Cargo.lock` changes, refresh the Rust dependency hash.
Use a trusted build with `lib.fakeHash` to discover the expected hash, replace it,
and then build and check the package.

`nix flake check` runs the package install checks, including authentication checks
and packaged asset, update and launcher tests. The Nix CI workflow runs
`nix flake check --print-build-logs` and
`nix fmt -- --check flake.nix nix/package.nix` on pull requests and pushes to `main`.
