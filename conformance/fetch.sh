#!/bin/sh
# Fetch GNU bash's source for its test suite and build the helper programs the
# tests call (recho, zecho, printenv, xcase). The tests are GPLv3 and stay out of
# this repository; everything lands in conformance/.cache.
set -eu

VERSION=5.2.21
SHA256=c8e31bdc59b69aaffc5b36509905ba3e5cbb12747091d27b4b977f078560d5b8
URL="https://ftp.gnu.org/gnu/bash/bash-${VERSION}.tar.gz"

HERE=$(cd "$(dirname "$0")" && pwd)
CACHE="${HERE}/.cache"
SRC="${CACHE}/bash-${VERSION}"
TARBALL="${CACHE}/bash-${VERSION}.tar.gz"

mkdir -p "${CACHE}"

if [ ! -f "${TARBALL}" ]; then
  echo "downloading ${URL}"
  curl -sSfL -o "${TARBALL}.part" "${URL}"
  mv "${TARBALL}.part" "${TARBALL}"
fi

echo "${SHA256}  ${TARBALL}" | sha256sum -c --quiet -

if [ ! -d "${SRC}" ]; then
  tar -xzf "${TARBALL}" -C "${CACHE}"
fi

# printenv and xcase include bash's own headers and lean on implicit libc
# declarations, which a modern compiler rejects without these
mkdir -p "${CACHE}/helpers"
for helper in recho zecho printenv xcase; do
  if [ ! -x "${CACHE}/helpers/${helper}" ]; then
    cc -O -w -I"${SRC}" -I"${SRC}/include" -I"${SRC}/lib" \
      -include string.h -include unistd.h -include stdlib.h \
      -o "${CACHE}/helpers/${helper}" "${SRC}/support/${helper}.c"
  fi
done

echo "bash ${VERSION} tests ready in ${SRC}/tests"
