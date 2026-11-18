{
  description = "Ovis browser client for herdr";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      ovis = pkgs.callPackage ./nix/package.nix { };
    in
    {
      packages.${system} = {
        inherit ovis;
        default = ovis;
      };
      checks.${system}.ovis = ovis;
      formatter.${system} = pkgs.nixfmt;
      overlays.default = final: _: {
        ovis = final.callPackage ./nix/package.nix { };
      };
    };
}
