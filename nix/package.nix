{
  lib,
  stdenvNoCC,
  rustPlatform,
  bun,
  cacert,
  makeWrapper,
  coreutils,
  git,
  gh,
  openssh,
  gnutar,
  extraPackages ? [ ],
}:
let
  src = lib.cleanSource ../.;
  version = (lib.importJSON ../package.json).version;

  ptySidecar = rustPlatform.buildRustPackage {
    pname = "ovis-pty-sidecar";
    version = (builtins.fromTOML (builtins.readFile ../crates/pty-sidecar/Cargo.toml)).package.version;
    src = ../crates/pty-sidecar;
    cargoHash = "sha256-vin5SGninwkDlpWIK4Cc5oO4cZ7DjTXDovUpu0fWwlE=";
  };

  bunDepsSrc = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../bun.lock
      ../patches
    ];
  };
  bunDepsFingerprint = builtins.substring 0 12 (
    builtins.hashString "sha256" (builtins.unsafeDiscardStringContext (toString bunDepsSrc))
  );

  bunDeps = stdenvNoCC.mkDerivation {
    pname = "ovis-bun-deps-${bunDepsFingerprint}";
    inherit version;
    src = bunDepsSrc;
    nativeBuildInputs = [
      bun
      cacert
    ];
    dontConfigure = true;
    dontFixup = true;

    buildPhase = ''
      runHook preBuild
      export HOME="$TMPDIR"
      export BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-cache"
      bun install --frozen-lockfile --ignore-scripts --no-progress
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      rm -rf node_modules/.cache
      mkdir -p "$out"
      cp -a node_modules "$out/node_modules"
      runHook postInstall
    '';

    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = "sha256-8sC+ZGVKFa55RK4L9RM2/7WAseHhd3JCPLGuoImrC9o=";
  };
in
assert lib.versionAtLeast bun.version (
  lib.removePrefix "bun@" (lib.importJSON ../package.json).packageManager
);
stdenvNoCC.mkDerivation {
  pname = "ovis";
  inherit version src;

  nativeBuildInputs = [
    bun
    git
    makeWrapper
  ];
  dontConfigure = true;
  dontStrip = true;
  dontPatchELF = true;
  dontPatchShebangs = true;

  buildPhase = ''
    runHook preBuild
    cp -a "${bunDeps}/node_modules" ./node_modules
    chmod -R u+w node_modules
    export HOME="$TMPDIR"
    bun --bun ./node_modules/vite/bin/vite.js build
    rm -rf node_modules/.cache
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/bin" "$out/share/ovis"
    cp -a dist server shared scripts integrations package.json THIRD_PARTY_NOTICES.md UPSTREAM_SYNC.json node_modules "$out/share/ovis/"
    makeWrapper "${bun}/bin/bun" "$out/bin/ovis-server" \
      --add-flags "$out/share/ovis/server/main.ts" \
      --set OVIS_MANAGED 0 \
      --set OVIS_ASSETS "$out/share/ovis" \
      --set OVIS_PTY_SIDECAR_BIN "${ptySidecar}/bin/ovis-pty-sidecar" \
      --set-default SSL_CERT_FILE "${cacert}/etc/ssl/certs/ca-bundle.crt" \
      --suffix PATH : "${
        lib.makeBinPath (
          [
            coreutils
            git
            gh
            openssh
            gnutar
          ]
          ++ extraPackages
        )
      }"
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    export HOME=$(mktemp -d)
    export OVIS_STATE_DIR=$(mktemp -d)
    export XDG_CONFIG_HOME=$(mktemp -d)
    export HERDR_SOCKET="$TMPDIR/no-herdr.sock"
    export OVIS_RUNTIME=herdr
    export OVIS_PTY_SIDECAR_BIN="${ptySidecar}/bin/ovis-pty-sidecar"
    export PATH="${
      lib.makeBinPath [
        coreutils
        git
        gh
        openssh
        gnutar
      ]
    }:$PATH"
    test -f "$out/share/ovis/dist/index.html"
    test -f "$out/share/ovis/dist/manifest.webmanifest"
    bun test --timeout 15000 "$out/share/ovis/server/cf-access.test.ts" "$out/share/ovis/server/entries.test.ts"
    cd "$TMPDIR"
    OVIS_PACKAGE_ROOT="$out" bun test --timeout 15000 ${./.}/smoke-check.ts
    runHook postInstallCheck
  '';

  passthru = { inherit bunDeps ptySidecar; };

  meta = {
    description = "Cloudflare Access protected browser client for herdr";
    homepage = "https://github.com/reta-ygs/ovis";
    license = lib.licenses.mit;
    platforms = [ "x86_64-linux" ];
    mainProgram = "ovis-server";
  };
}
