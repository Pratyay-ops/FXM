#!/usr/bin/env bash
# A minimal pkg-config for the core's cross build (libs.sh puts it on the PATH as pkg-config).
#
# FFmpeg's configure finds libopus only through pkg-config, LAME's configure insists on one,
# macOS has none, and a host pkg-config could answer with the host's libraries. This one reads
# only the .pc files in PKG_CONFIG_LIBDIR (the build's own prefix) and answers what those
# configure scripts ask:
#
#   pkg-config --version | --atleast-pkgconfig-version V
#   pkg-config --exists [--print-errors] 'name [op version]' …
#   pkg-config --atleast-version V | --exact-version V | --max-version V name
#   pkg-config --cflags | --cflags-only-I | --libs | --modversion [--static] name
#   pkg-config --variable=NAME [--static] name
#
# Written for bash 3.2, the macOS default: no associative arrays.
set -euo pipefail

mode=
variable=
wanted=
print_errors=false
specs=()
while [ $# -gt 0 ]; do
  case $1 in
    --version) echo 0.29.2 && exit 0 ;;
    --atleast-pkgconfig-version) exit 0 ;;
    --atleast-version | --exact-version | --max-version)
      mode=$1
      wanted=${2:?"$1 needs a version"}
      shift
      ;;
    --atleast-version=* | --exact-version=* | --max-version=*)
      mode=${1%%=*}
      wanted=${1#*=}
      ;;
    --exists | --cflags | --cflags-only-I | --libs | --modversion) mode=$1 ;;
    --variable=*) mode=--variable && variable=${1#--variable=} ;;
    --print-errors) print_errors=true ;;
    --static | --short-errors | --silence-errors) ;;
    -*) echo "pkg-config.sh: unsupported option $1" >&2 && exit 2 ;;
    *) specs+=("$1") ;;
  esac
  shift
done
if [ -z "$mode" ] || [ ${#specs[@]} -eq 0 ]; then
  echo "usage: pkg-config --exists|--cflags|--libs|--modversion|--variable=NAME package" >&2
  exit 2
fi

# Prints the .pc file of a package, or fails.
find_pc() {
  local dir rest=${PKG_CONFIG_LIBDIR:-}
  while [ -n "$rest" ]; do
    dir=${rest%%:*}
    if [ "$dir" = "$rest" ]; then rest=; else rest=${rest#*:}; fi
    if [ -n "$dir" ] && [ -f "$dir/$1.pc" ]; then
      echo "$dir/$1.pc"
      return 0
    fi
  done
  return 1
}

# Prints field ("Cflags:") or variable ("prefix=") $2 of the .pc file $1, with every ${name}
# the file defines expanded.
read_pc() {
  local file=$1 want=$2 line value= i round
  local -a names=() values=()
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%%#*}
    if [[ $line =~ ^([A-Za-z0-9_.]+)=(.*)$ ]]; then
      names+=("${BASH_REMATCH[1]}")
      values+=("${BASH_REMATCH[2]}")
      [ "${BASH_REMATCH[1]}" = "$want" ] && value=${BASH_REMATCH[2]}
    elif [[ $line =~ ^([A-Za-z0-9_.]+):[[:space:]]*(.*)$ ]]; then
      [ "${BASH_REMATCH[1]}:" = "$want" ] && value=${BASH_REMATCH[2]}
    fi
  done <"$file"
  # A few rounds: prefix → exec_prefix → libdir.
  for round in 1 2 3 4 5; do
    case $value in
      *'${'*) ;;
      *) break ;;
    esac
    for i in "${!names[@]}"; do
      value=${value//"\${${names[$i]}}"/${values[$i]}}
    done
  done
  echo "$value"
}

# Compares dotted versions: prints -1, 0 or 1.
compare_versions() {
  local a=$1 b=$2 x y
  while [ -n "$a" ] || [ -n "$b" ]; do
    x=${a%%.*} y=${b%%.*}
    x=${x//[!0-9]/} y=${y//[!0-9]/}
    x=${x:-0} y=${y:-0}
    if [ "$((10#$x))" -lt "$((10#$y))" ]; then echo -1 && return; fi
    if [ "$((10#$x))" -gt "$((10#$y))" ]; then echo 1 && return; fi
    if [ "${a#*.}" = "$a" ]; then a=; else a=${a#*.}; fi
    if [ "${b#*.}" = "$b" ]; then b=; else b=${b#*.}; fi
  done
  echo 0
}

# Whether version $1 satisfies "$2 $3" (an operator and a version).
satisfies() {
  local order
  order=$(compare_versions "$1" "$3")
  case $2 in
    '>=') [ "$order" -ge 0 ] ;;
    '>') [ "$order" -gt 0 ] ;;
    '<=') [ "$order" -le 0 ] ;;
    '<') [ "$order" -lt 0 ] ;;
    '=' | '==') [ "$order" -eq 0 ] ;;
    '!=') [ "$order" -ne 0 ] ;;
    *) return 1 ;;
  esac
}

fail() {
  if $print_errors; then echo "$1" >&2; fi
  exit 1
}

# Each spec is "name" or "name op version"; a following "op" and "version" may also come as
# separate arguments (pkg-config --exists opus '>=' 1.1).
i=0
while [ $i -lt ${#specs[@]} ]; do
  read -r package op version <<<"${specs[$i]}"
  next=$((i + 1))
  if [ -z "${op:-}" ] && [ $((i + 2)) -lt $((${#specs[@]} + 1)) ]; then
    case ${specs[$next]:-} in
      '>=' | '>' | '<=' | '<' | '=' | '==' | '!=')
        op=${specs[$next]}
        version=${specs[$((i + 2))]:-}
        next=$((i + 3))
        ;;
    esac
  fi
  i=$next
  pc=$(find_pc "$package") || fail "Package $package was not found in the pkg-config search path"
  have=$(read_pc "$pc" Version:)
  if [ -n "${op:-}" ]; then
    satisfies "$have" "$op" "${version:-}" || fail "Requested '$package $op $version' but version of $package is $have"
  fi
  case $mode in
    --exists) ;;
    --atleast-version) satisfies "$have" '>=' "$wanted" || exit 1 ;;
    --exact-version) satisfies "$have" '=' "$wanted" || exit 1 ;;
    --max-version) satisfies "$have" '<=' "$wanted" || exit 1 ;;
    --modversion) echo "$have" ;;
    --cflags) read_pc "$pc" Cflags: ;;
    --cflags-only-I)
      flags=
      for flag in $(read_pc "$pc" Cflags:); do
        case $flag in -I*) flags="$flags $flag" ;; esac
      done
      echo "${flags# }"
      ;;
    --libs)
      libs=$(read_pc "$pc" Libs:)
      private=$(read_pc "$pc" Libs.private:)
      echo "$libs${private:+ $private}"
      ;;
    --variable) read_pc "$pc" "$variable" ;;
  esac
done
