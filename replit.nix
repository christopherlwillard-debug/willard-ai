{pkgs}: let
  official7zip = pkgs.stdenvNoCC.mkDerivation {
    pname = "willard-7zip";
    version = "26.05";
    src = pkgs.fetchurl {
      url = "https://github.com/ip7z/7zip/releases/download/26.05/7z2605-linux-x64.tar.xz";
      sha256 = "22cf82fcc6eb7474f1d5bb4f02c0f8ebd573a718089d6833dc30f8350a3b232e";
    };
    nativeBuildInputs = [ pkgs.gnutar pkgs.xz ];
    dontUnpack = true;
    dontBuild = true;
    installPhase = ''
      mkdir -p "$out/bin"
      tar -xJf "$src" -C "$TMPDIR"
      install -m 0555 "$TMPDIR/7zzs" "$out/bin/7zzs"
    '';
    meta = {
      description = "Official static 7-Zip 26.05 binary";
      homepage = "https://www.7-zip.org/";
    };
  };
in {
  deps = [
    official7zip
    pkgs.chromium
    pkgs.got
    pkgs.exiftool
    pkgs.wayland
    pkgs.libGL
    pkgs.vulkan-loader
    pkgs.libdrm
    pkgs.mesa
    pkgs.alsa-lib
    pkgs.cairo
    pkgs.pango
    pkgs.xorg.libXtst
    pkgs.xorg.libXrandr
    pkgs.xorg.libXfixes
    pkgs.xorg.libXext
    pkgs.xorg.libXdamage
    pkgs.xorg.libXcomposite
    pkgs.xorg.libxcb
    pkgs.xorg.libX11
    pkgs.libxkbcommon
    pkgs.fontconfig
    pkgs.expat
    pkgs.dbus
    pkgs.cups
    pkgs.at-spi2-atk
    pkgs.atk
    pkgs.nspr
    pkgs.nss
    pkgs.glib
  ];
}
