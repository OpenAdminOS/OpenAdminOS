#!/usr/bin/env bash
set -euo pipefail

input_dir="${1:-release-assets}"
output_dir="${2:-apt-pages}"

suite="${APT_REPO_SUITE:-stable}"
component="${APT_REPO_COMPONENT:-main}"
arch="${APT_REPO_ARCH:-amd64}"
origin="${APT_REPO_ORIGIN:-OpenAdminOS}"
label="${APT_REPO_LABEL:-OpenAdminOS}"
description="${APT_REPO_DESCRIPTION:-OpenAdminOS Debian package repository}"
domain="${APT_REPO_DOMAIN:-repo.openadminos.com}"
cname="${APT_REPO_CNAME-repo.openadminos.com}"

if [ -z "${APT_GPG_PRIVATE_KEY:-}" ]; then
  echo "APT_GPG_PRIVATE_KEY is required to sign the apt repository." >&2
  exit 1
fi

for command_name in dpkg-scanpackages apt-ftparchive gpg gzip; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name is required to build the apt repository." >&2
    exit 1
  fi
done

shopt -s nullglob
debs=("$input_dir"/*.deb)
if [ "${#debs[@]}" -eq 0 ]; then
  echo "No .deb package found in $input_dir." >&2
  exit 1
fi

if [ "${#debs[@]}" -gt 1 ]; then
  echo "Expected one .deb package in $input_dir, found ${#debs[@]}." >&2
  printf '  %s\n' "${debs[@]}" >&2
  exit 1
fi

rm -rf "$output_dir"

repo_root="$output_dir/debian"
pool_dir="$repo_root/pool/main/o/openadminos"
binary_dir="$repo_root/dists/$suite/$component/binary-$arch"

mkdir -p "$pool_dir" "$binary_dir"
cp "${debs[0]}" "$pool_dir/"

cat > "$output_dir/index.html" <<EOF
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>OpenAdminOS apt repository</title>
  </head>
  <body>
    <h1>OpenAdminOS apt repository</h1>
    <p>Use <code>https://$domain/debian</code> as the apt source URL.</p>
  </body>
</html>
EOF

if [ -n "$cname" ]; then
  printf '%s\n' "$cname" > "$output_dir/CNAME"
fi
touch "$output_dir/.nojekyll"

(
  cd "$repo_root"
  dpkg-scanpackages --arch "$arch" pool > "dists/$suite/$component/binary-$arch/Packages"
  gzip -n -k -f "dists/$suite/$component/binary-$arch/Packages"
)

release_config="$(mktemp)"
cat > "$release_config" <<EOF
APT::FTPArchive::Release::Origin "$origin";
APT::FTPArchive::Release::Label "$label";
APT::FTPArchive::Release::Suite "$suite";
APT::FTPArchive::Release::Codename "$suite";
APT::FTPArchive::Release::Architectures "$arch";
APT::FTPArchive::Release::Components "$component";
APT::FTPArchive::Release::Description "$description";
EOF

(
  cd "$repo_root"
  apt-ftparchive -c "$release_config" release "dists/$suite" > "dists/$suite/Release"
)

rm -f "$release_config"

export GNUPGHOME
GNUPGHOME="$(mktemp -d)"
chmod 700 "$GNUPGHOME"
cleanup() {
  rm -rf "$GNUPGHOME"
}
trap cleanup EXIT

printf '%s\n' "$APT_GPG_PRIVATE_KEY" | gpg --batch --import

signing_key="${APT_GPG_KEY_ID:-}"
if [ -z "$signing_key" ]; then
  signing_key="$(
    gpg --batch --list-secret-keys --with-colons \
      | awk -F: '$1 == "fpr" { print $10; exit }'
  )"
fi

if [ -z "$signing_key" ]; then
  echo "No signing key was imported from APT_GPG_PRIVATE_KEY." >&2
  exit 1
fi

gpg --batch --yes --export "$signing_key" > "$repo_root/openadminos-archive-keyring.pgp"
gpg --batch --yes --armor --export "$signing_key" > "$repo_root/openadminos-archive-keyring.asc"

passphrase_args=(--pinentry-mode loopback --passphrase "${APT_GPG_PASSPHRASE:-}")

(
  cd "$repo_root/dists/$suite"
  gpg --batch --yes "${passphrase_args[@]}" \
    --local-user "$signing_key" \
    --digest-algo SHA256 \
    --clearsign \
    --output InRelease \
    Release
  gpg --batch --yes "${passphrase_args[@]}" \
    --local-user "$signing_key" \
    --digest-algo SHA256 \
    --armor \
    --detach-sign \
    --output Release.gpg \
    Release
  gpg --batch --verify InRelease >/dev/null
  gpg --batch --verify Release.gpg Release >/dev/null
)

printf 'Built signed apt repository at %s\n' "$output_dir"
find "$output_dir" -type f | sort
