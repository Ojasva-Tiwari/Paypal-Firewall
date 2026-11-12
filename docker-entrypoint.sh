#!/bin/sh
set -eu

PAYGUARD_UID=1001
PAYGUARD_GID=1001
DEFAULT_DATA_DIR="/app/data"

resolve_db_dir() {
  raw_path="$1"
  case "$raw_path" in
    ""|":memory:"|file:*)
      return 0
      ;;
  esac

  dir_path="$(dirname "$raw_path")"
  case "$dir_path" in
    ""|".")
      printf '%s\n' "/app"
      ;;
    ./*)
      printf '/app/%s\n' "${dir_path#./}"
      ;;
    /*)
      printf '%s\n' "$dir_path"
      ;;
    *)
      printf '/app/%s\n' "$dir_path"
      ;;
  esac
}

is_safe_data_dir() {
  case "$1" in
    ""|"/"|"/app"|"/bin"|"/boot"|"/dev"|"/etc"|"/home"|"/lib"|"/lib64"|"/media"|"/mnt"|"/opt"|"/proc"|"/root"|"/run"|"/sbin"|"/srv"|"/sys"|"/tmp"|"/usr"|"/var")
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

ensure_writable_as_root() {
  target_dir="$1"
  mkdir -p -- "$target_dir"
  chown -R "${PAYGUARD_UID}:${PAYGUARD_GID}" -- "$target_dir"
  chmod u+rwx -- "$target_dir"
  chmod -R u+rwX -- "$target_dir"
}

if [ "$#" -eq 0 ]; then
  set -- node dist/src/server.js
fi

DB_TARGET="${DATABASE_PATH:-${DB_PATH:-/app/data/payguard.db}}"
CUSTOM_DB_DIR="$(resolve_db_dir "$DB_TARGET")"

if [ "$(id -u)" -eq 0 ]; then
  ensure_writable_as_root "$DEFAULT_DATA_DIR"

  if is_safe_data_dir "$CUSTOM_DB_DIR" && [ "$CUSTOM_DB_DIR" != "$DEFAULT_DATA_DIR" ]; then
    ensure_writable_as_root "$CUSTOM_DB_DIR"
  fi

  CHECK_DIR="$DEFAULT_DATA_DIR"
  if is_safe_data_dir "$CUSTOM_DB_DIR"; then
    CHECK_DIR="$CUSTOM_DB_DIR"
  fi

  if ! setpriv --reuid="$PAYGUARD_UID" --regid="$PAYGUARD_GID" --clear-groups --no-new-privs \
    sh -c '[ -d "$1" ] && [ -w "$1" ] && [ -x "$1" ]' _ "$CHECK_DIR"; then
    echo "[entrypoint] ERROR: data directory '$CHECK_DIR' is not writable by payguard (${PAYGUARD_UID}:${PAYGUARD_GID})" >&2
    exit 1
  fi

  exec setpriv --reuid="$PAYGUARD_UID" --regid="$PAYGUARD_GID" --clear-groups --no-new-privs -- "$@"
fi

CHECK_DIR="$DEFAULT_DATA_DIR"
if is_safe_data_dir "$CUSTOM_DB_DIR"; then
  CHECK_DIR="$CUSTOM_DB_DIR"
fi

if [ ! -d "$CHECK_DIR" ]; then
  mkdir -p -- "$CHECK_DIR"
fi

if [ ! -w "$CHECK_DIR" ] || [ ! -x "$CHECK_DIR" ]; then
  echo "[entrypoint] ERROR: data directory '$CHECK_DIR' is not writable by uid $(id -u) gid $(id -g)" >&2
  exit 1
fi

exec "$@"

