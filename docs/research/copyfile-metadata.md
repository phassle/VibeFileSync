# Research: `copyfile(3)` metadata behavior, APFS → exFAT

Ticket: [phassle/VibeFileSync#3](https://github.com/phassle/VibeFileSync/issues/3)

Method: read against primary sources only — Apple's `copyfile(3)` man page, the
`copyfile.h` flag definitions, the actual `copyfile.c` implementation from
[apple-oss-distributions/copyfile](https://github.com/apple-oss-distributions/copyfile),
the xattr fallback machinery in
[apple-oss-distributions/xnu](https://github.com/apple-oss-distributions/xnu)'s
`bsd/vfs/vfs_xattr.c`, and the `setxattr(2)`, `getattrlist(2)`, `mount_exfat(8)`
man pages. Local versions were read via `man` and from
`/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/copyfile.h`;
the opensource `.c` files were fetched directly from GitHub raw content.
No copy experiments were run against real volumes — every claim below is
sourced to a man-page section or a specific function/line in the cited files.

## TL;DR

- **`COPYFILE_ALL` = `COPYFILE_STAT | COPYFILE_ACL | COPYFILE_XATTR | COPYFILE_DATA`.**
  It is data + POSIX stat info + ACLs + xattrs (which includes FinderInfo,
  Finder tags, and the resource fork, since those are all just xattr
  namespaces). It does **not** include quarantine flags, BSD file flags
  survival guarantees, or anything about symlinks/special files beyond what's
  described below.
- **Yes — macOS already produces AppleDouble `._` sidecar files on exFAT
  automatically, and it does this for free, underneath `copyfile()`, without
  any `COPYFILE_PACK` involvement.** The fallback lives in the kernel's VFS
  xattr layer (`vn_setxattr`/`vn_getxattr` in `vfs_xattr.c`), not in
  `copyfile.c`. Any `fsetxattr()`/`setxattr()` call — from `copyfile()`,
  Finder, `cp -p`, `rsync -E`, `ditto`, anything — that hits a filesystem
  whose vnode op returns `ENOTSUP` (exFAT, FAT, SMB shares, …) is silently
  retried by the kernel against a `._`-prefixed AppleDouble file next to the
  real one. `copyfile_xattr()` in `copyfile.c` just calls plain `fsetxattr()`
  in a loop; it has no special-case code for exFAT and needs none.
- **`COPYFILE_PACK`/`COPYFILE_UNPACK` are a different, unrelated feature.**
  They serialize a source file's *entire* metadata-plus-forks picture into a
  single literal AppleDouble binary blob and write that blob as the byte
  content of the destination path (or read it back). They are for producing
  an explicit standalone AppleDouble container (e.g. for archiving/transport),
  not an automatic "my destination lacks xattrs, fall back to packing"
  behavior — that fallback already happens for free at the kernel level, as
  above. This confirms and sharpens the prior review's already-adopted
  position.
- **What genuinely degrades on exFAT, and is not masked by any sidecar
  mechanism:** POSIX permissions/ownership (exFAT has no on-disk UID/GID/mode
  fields — mounted with `MNT_UNKNOWNPERMISSIONS` unless explicit `-u/-g/-m`
  is given), ACLs (no on-disk representation; `copyfile` only warns on
  failure, doesn't error), timestamp sub-second precision beyond exFAT's
  format granularity, BSD flags (`chflags`, e.g. `UF_HIDDEN`/immutable —
  silently best-effort), and **symbolic links, which exFAT cannot represent
  at all** — and unlike xattrs/ACLs/stat, a failed `symlink()` call is a hard
  copy failure in `copyfile.c`, not a silent downgrade.

## 1. What does `COPYFILE_ALL` actually preserve/lose, mechanically?

Flag definitions, from `copyfile.h`
([apple-oss-distributions/copyfile](https://github.com/apple-oss-distributions/copyfile/blob/main/copyfile.h)
and identical local `/usr/include/copyfile.h`):

```
#define COPYFILE_ACL        (1<<0)
#define COPYFILE_STAT        (1<<1)
#define COPYFILE_XATTR        (1<<2)
#define COPYFILE_DATA        (1<<3)

#define COPYFILE_SECURITY   (COPYFILE_STAT | COPYFILE_ACL)
#define COPYFILE_METADATA   (COPYFILE_SECURITY | COPYFILE_XATTR)
#define COPYFILE_ALL         (COPYFILE_METADATA | COPYFILE_DATA)
```

Per `copyfile(3)`: `COPYFILE_STAT` copies "POSIX information (mode,
modification time, etc.)"; `COPYFILE_XATTR` copies "extended attributes";
`COPYFILE_ACL` copies "access control lists." Finder tags, color labels, and
the classic resource fork are **not separate flags** — they live inside the
xattr namespace (`com.apple.FinderInfo`, `com.apple.ResourceFork`,
`com.apple.metadata:_kMDItemUserTags`) and ride along with `COPYFILE_XATTR`.

Per-flag control flow, read directly out of `copyfile_internal()` in
`copyfile.c` (function offsets as fetched from the `main` branch,
2004-2023 Apple, Inc. copyright header):

- **`copyfile_xattr()`** (`copyfile.c`, function starting at the
  `static int copyfile_xattr(copyfile_state_t s)` definition): deletes the
  destination's existing xattrs, lists the source's xattr names via
  `flistxattr()`, then for each one calls `fsetxattr(s->dst_fd, name, ...)`.
  If `flistxattr()` on either side returns `ENOTSUP`/`EPERM` (the filesystem
  doesn't do xattrs at all), the function returns `0` (success, nothing to
  do) rather than an error. If an individual `fsetxattr()` call fails, the
  loop logs a warning via `copyfile_warn()` and **continues to the next
  attribute** rather than aborting — a partial-xattr-copy failure does not
  stop the file data copy.
  In `copyfile_internal()`, the dispatch is: `if (COPYFILE_XATTR & flags) { if ((ret = copyfile_xattr(s)) < 0) { if (errno != ENOTSUP && errno != EPERM) copyfile_warn(...); goto exit; } }` — followed by the `COPYFILE_DATA` block. In practice, because of the kernel-level fallback described in §2, `fsetxattr()` against exFAT essentially never returns `ENOTSUP` to userspace in the first place — the kernel already redirected the write to a `._` sidecar and reported success.
- **`copyfile_stat()`**: sets mtime/atime via `fsetattrlist()`, then
  `fchown()`, then `fchmod()`, then BSD flags via
  `FSIOC_CAS_BSDFLAGS`. The comments in the source are explicit about the
  error policy: `/* If this fails, we don't care */` above the `fchown()`
  call, and the BSD-flags comment reads `/* Not all filesystems support BSD flags (example: NFS), so ignore errors. */`. None of these calls' failures are propagated as a copy error.
- **`copyfile_security()`** (ACLs + POSIX mode/owner, used for
  `COPYFILE_SECURITY`): tries `fchmodx_np()` first; on failure it falls back
  to discrete `fchmod()`/`fchown()`/`acl_set_fd()` calls. The source
  comments explain the philosophy directly: *"we don't care if the fchown
  fails, but we do care if the mode or ACL can't be set. For historical
  reasons, we simply log those failures, however."* — i.e. even a failed
  `acl_set_fd()` only produces a `copyfile_warn()` call, not a nonzero return
  from `copyfile()`.
- **Symlinks**: handled via `readlink(s->src, ...)` followed by
  `symlink(bp, s->dst)`. Unlike the metadata paths above, a `symlink()`
  failure that isn't `EEXIST` is treated as fatal: `copyfile_warn("Cannot make symlink %s", s->dst); ... return -1;`. This is the one path in `copyfile.c` where a
  destination-filesystem incompatibility becomes a hard copy error rather than
  a silently-dropped attribute.
- **Special files** (block/char devices, FIFOs, sockets): no `mknod()`-style
  recreation logic exists anywhere in `copyfile.c` (confirmed by grep for
  `S_ISBLK`/`S_ISCHR`/`S_ISFIFO`/`S_ISSOCK`/`mknod`, all absent). `copyfile(3)`
  is documented and implemented for regular files, directories, and symlinks
  only.
- **Hard links**: `copyfile(3)` has no hard-link-preserving mode; each source
  path is copied as an independent object. This isn't exFAT-specific — POSIX
  `link(2)` is same-filesystem-only, so a cross-volume copy can never
  reproduce a hard-link graph regardless of destination format.
- **`COPYFILE_CLONE`/`COPYFILE_CLONE_FORCE`**: implemented via
  `clonefileat(2)`, which is a same-volume copy-on-write clone. It is
  irrelevant for an APFS→exFAT copy: cross-volume clone attempts fail, and
  `COPYFILE_CLONE` (the best-try variant) transparently falls back to a
  normal `COPYFILE_DATA`-style copy in that case per the man page
  ("if cloning fails, fallback to copying the file").

## 2. Does macOS already produce AppleDouble `._` sidecars on exFAT automatically?

**Yes — at the kernel VFS layer, independent of `copyfile()` or any userspace
tool.** This is the key mechanical finding of this research.

`xnu`'s `bsd/vfs/vfs_xattr.c`
([apple-oss-distributions/xnu](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/vfs/vfs_xattr.c))
implements `vn_setxattr()`/`vn_getxattr()` — the vnode-layer functions behind
the `setxattr(2)`/`getxattr(2)`/`fsetxattr(2)`/`fgetxattr(2)` syscalls. Both
call the filesystem's own vnode operation first (`VNOP_SETXATTR`/
`VNOP_GETXATTR`); the fallback is explicit and unconditional unless the
caller opts out:

```c
error = VNOP_SETXATTR(vp, name, uio, options, context);
...
if (error == ENOTSUP && !(options & XATTR_NODEFAULT)) {
    /*
     * A filesystem may keep some EAs natively and return ENOTSUP for others.
     */
    error = default_setxattr(vp, name, uio, options, context);
}
```//`vn_setxattr()`, `vfs_xattr.c`

`default_setxattr()` routes (for real, non-stub kernels — a build-time
`#else` branch simply returns `ENOTSUP` when the mechanism is compiled out)
to `default_setxattr_doubleagent()`, which opens (creating if necessary) a
"`._`"-prefixed AppleDouble file next to the target (`ATTR_FILE_PREFIX` is
literally `"._"`, `vfs_xattr.c`), and writes the attribute data into it via a
`doubleagentd` Mach IPC helper (`open_xattrfile()`, `doubleagent_allocate_xattr()`,
`vfs_xattr.c` inside `default_setxattr_doubleagent()`). The file-level comment
block in `vfs_xattr.c` (mirrored from the older in-kernel implementation in
`copyfile.c`, lines documenting *"Create an Apple Double '._' file from a
file's extended attributes"*) spells out the exact AppleDouble binary layout
this shim produces. `com.apple.FinderInfo` (Finder tags/color labels/flags)
and `com.apple.ResourceFork` are handled as special-cased xattr names inside
this same function — they are not a separate code path.

Critically, **`copyfile.c` never passes `XATTR_NODEFAULT`** to any of its
`fsetxattr()`/`fgetxattr()` calls (confirmed by grepping the whole file for
`XATTR_NODEFAULT`: zero matches), so this fallback is always live for
copies done through `copyfile()`. And because this happens inside the kernel
before `fsetxattr()` returns to userspace, `copyfile_xattr()`'s own
`ENOTSUP`-handling code (§1) is largely moot for exFAT — the syscall doesn't
report `ENOTSUP` to `copyfile()` in the first place; it reports success,
because the kernel already substituted an AppleDouble sidecar write.

This is also *not* copyfile-specific or even Apple-tool-specific: it is a
property of the `setxattr(2)`/`fsetxattr(2)` syscalls themselves. Finder,
`cp -p`, `rsync -E`, `ditto`, and any other program that calls `fsetxattr()`
against a file on exFAT (or FAT, or an SMB share whose remote filesystem
lacks native EAs) gets the same automatic `._` sidecar creation. This
matches the long-documented, widely-observed behavior of `._` files
appearing when copying from a Mac to FAT32/exFAT drives or non-Mac network
shares — see community/support discussion corroborating the observed
behavior:
[Apple Support Communities: "Interoperability of FAT32, ex-FAT, HFS+…"](https://discussions.apple.com/thread/8197955),
[Apple Support Communities: "Stop appledouble from creating on NAS"](https://discussions.apple.com/thread/5260367).
(These are secondary/corroborating sources for the observable symptom; the
mechanism itself is sourced above directly from `vfs_xattr.c`.)

**One important gap in the primary-source chain:** Apple's exFAT filesystem
implementation itself (the kext/driver that actually mounts exFAT volumes on
macOS) is **closed-source** — there is no `exfat` repository under
[apple-oss-distributions](https://github.com/apple-oss-distributions)
(confirmed via the GitHub API: searching and listing that org's ~500 repos
turns up `copyfile`, `hfs`, `xnu`, but no FAT/exFAT filesystem implementation).
The public `msdosfs` driver (legacy FAT12/16/32, also apple-oss-distributions,
under `xnu`) was inspected as the closest available analogue: its
`msdosfs_vnops.c` defines no `VNOP_GETXATTR`/`VNOP_SETXATTR` vnode operations
at all (confirmed by grep — zero matches for `xattr` in that file), which
means any xattr syscall against a FAT-mounted vnode necessarily returns
`ENOTSUP` from the default vnode op table and hits the `default_setxattr`
fallback above. exFAT is understood (per Apple's and Microsoft's exFAT
specifications, and universally-observed behavior) to have the same absence
of a native extended-attribute storage format, so the same fallback applies,
but this specific inference — "exFAT's own vnode ops return ENOTSUP the same
way FAT's do" — is not verified against exFAT's own (unpublished) source and
should be flagged as a residual assumption rather than a directly-cited fact.

## 3. `COPYFILE_PACK`/`COPYFILE_UNPACK`: precise semantics (sharpening the prior review)

The prior review's adopted framing is correct and this research confirms and
sharpens it with the actual mechanics:

- `copyfile(3)` man page: *"`COPYFILE_PACK` Serialize the from file. The to
  file is an AppleDouble-format file."* and *"`COPYFILE_UNPACK` Unserialize
  the from file. The from file is an AppleDouble-format file; the to file
  will have the extended attributes, ACLs, resource fork, and FinderInfo data
  from the to file[sic — from the *from* file]..."*
- In `copyfile_internal()`: `COPYFILE_PACK` and `COPYFILE_UNPACK` are handled
  as **the very first checks**, before any of the normal xattr/data/security
  logic runs, and each is mutually exclusive with the rest of the flags:
  `if (COPYFILE_PACK & flags) { ret = copyfile_pack(s); ...; goto exit; }`.
  They are not modifiers layered on top of `COPYFILE_ALL` — they replace the
  entire copy operation with a serialize/deserialize step.
- `copyfile_pack()` builds an **in-memory AppleDouble binary blob**: it fills
  in an `apple_double_header_t` (`magic = ADH_MAGIC`, `version = ADH_VERSION`,
  two entries for `AD_FINDERINFO` and `AD_RESOURCE`), collects the source's
  ACL (if `COPYFILE_ACL` is set) and xattr list (if `COPYFILE_XATTR` is set)
  into an attribute-entry table inside that same blob, and — per the header
  comment directly above the struct definitions — *"Create an Apple Double
  '._' file from a file's extended attributes"*. This blob is written as the
  **literal byte content of the `to` path** (a plain `write()`/`fsetxattr()`-free
  data write to `s->dst_fd`, which was opened as a normal file), not as a set
  of xattrs on a data-bearing file. On failure, `copyfile_internal()` explicitly
  `unlink(s->dst)`s the destination, confirming `to` is understood to be a
  single, disposable, AppleDouble-container file, not a companion sidecar next
  to a separately-copied data file.
- Consequently: **`COPYFILE_PACK` is a manual, two-step, caller-orchestrated
  scheme** — the caller is responsible for (a) naming the destination
  appropriately (conventionally `._<name>`) and (b) separately copying the
  actual data fork (e.g., via a normal `COPYFILE_DATA` copy of `<name>`) if
  byte-for-byte data preservation is also wanted, since `copyfile_pack()`'s
  AppleDouble output does not include the file's regular data fork by default.
  This is architecturally nothing like the automatic, transparent, per-syscall
  kernel fallback in §2. Presenting `COPYFILE_PACK` as "the way copyfile
  handles filesystems without xattr support" would be wrong: that handling
  already happens automatically, underneath both `copyfile_xattr()` and any
  other xattr-writing code, without needing `COPYFILE_PACK` at all.

## 4. Preserved vs. degraded metadata matrix

| Metadata | APFS → APFS (native) | APFS → exFAT (via `copyfile(3)`, `COPYFILE_ALL`) |
|---|---|---|
| File data | Preserved (`COPYFILE_DATA`) | Preserved |
| POSIX mode bits | Preserved (`fchmod`, `COPYFILE_STAT`) | **Best-effort only.** exFAT's on-disk format has no per-file POSIX mode/uid/gid; the volume is typically mounted `MNT_UNKNOWNPERMISSIONS` (virtual/mount-derived perms) unless `-u/-g/-m` given at mount time (`mount_exfat(8)`). `fchmod`/`fchown` failures are silently ignored by `copyfile_stat()`/`copyfile_security()` even when they do "succeed" at the syscall level, so real per-file mode/owner fidelity is not durable. |
| Ownership (uid/gid) | Preserved | Not durable — see above; `fchown()` failures explicitly ignored ("If this fails, we don't care", `copyfile_stat()`). |
| ACLs | Preserved (`COPYFILE_ACL`) | **Dropped, silently.** exFAT has no ACL storage. `acl_set_fd()` failure only triggers `copyfile_warn()`, not a nonzero return from `copyfile()` — the process reports success. |
| Extended attributes (generic) | Preserved natively | **Preserved, but relocated.** Kernel `vn_setxattr()` fallback (§2) transparently redirects to a `._`-prefixed AppleDouble sidecar file. Present as long as the sidecar travels with the data file and both are read back through the same VFS shim (e.g. on a later Mac); opaque/inaccessible to non-Apple exFAT readers (Windows, Linux) except as a stray `._name` file. |
| FinderInfo (color labels, some Finder flags) | Preserved | Preserved via the same xattr fallback (`com.apple.FinderInfo` is just another xattr name special-cased inside `default_setxattr_doubleagent()`). |
| Finder tags (`com.apple.metadata:_kMDItemUserTags`) | Preserved | Preserved via the same xattr fallback. |
| Resource fork | Preserved | Preserved via the same xattr fallback (`com.apple.ResourceFork`, handled specially inside `default_setxattr_doubleagent()`, including offset/position semantics). |
| BSD flags (`UF_HIDDEN`, immutable, etc.) | Preserved | **Best-effort, silently ignored on failure** — `copyfile_stat()`'s comment: *"Not all filesystems support BSD flags (example: NFS), so ignore errors."* Same policy applies to exFAT. |
| Timestamps (mtime/atime) | Preserved, ~ns precision (`fsetattrlist`) | **Precision degraded** to whatever exFAT's on-disk timestamp granularity supports; `copyfile_stat()` attempts nanosecond `fsetattrlist()` regardless but the underlying format cannot store that precision. `copyfile` does not detect or report this — the `fsetattrlist()` call is not checked for a return value that would reveal truncation. |
| Symbolic links | Preserved (`readlink`+`symlink`) | **Hard failure**, not a silent downgrade. exFAT has no on-disk symlink representation; `copyfile.c`'s `symlink()` call treats any non-`EEXIST` error as fatal and aborts that copy with a `copyfile_warn()` + `return -1`. |
| Special files (device nodes, FIFOs, sockets) | N/A for a sync tool (out of scope for `copyfile(3)` entirely) | Same — `copyfile(3)` has no path for these on any destination; exFAT couldn't represent them either. |
| Hard links (multi-link source objects) | Not reproduced by `copyfile(3)` (no hard-link mode) | Same — moot; also physically impossible cross-volume regardless of format. |
| Quarantine flags | Applied via `qtn_file_apply_to_fd()`; failures ignored except via callback | Same policy; exFAT sidecar handling of quarantine xattr is explicitly special-cased/skipped in `copyfile_xattr()`'s dst-cleanup loop (`XATTR_QUARANTINE_NAME` is skipped when clearing destination xattrs). |

## 5. v1 recommendation

1. **Use `COPYFILE_ALL` (or, more precisely, `COPYFILE_STAT | COPYFILE_XATTR |
   COPYFILE_DATA`, deliberately omitting `COPYFILE_ACL`) as the v1 copy
   call for both APFS and exFAT destinations, with no destination-format
   branching in the copy call itself.** The kernel already does the
   right thing transparently for xattrs (§2); there is no code the sync
   engine needs to write to get `._` sidecar behavior on exFAT — it falls
   out of calling `fsetxattr()`/`copyfile()` normally. **Do not add a
   `COPYFILE_PACK`/`COPYFILE_UNPACK` path.** It solves a different problem
   (producing a standalone AppleDouble container file) and would only add
   complexity and a second, divergent metadata-preservation code path for no
   benefit here.
2. **Drop `COPYFILE_ACL` from the v1 flag set entirely, on both destination
   types**, rather than passing it and letting failures be silently
   swallowed. Since `copyfile_security()` only warns (to stderr) on
   `acl_set_fd()` failure and still reports overall success, requesting ACL
   copy and getting silent partial failure is worse than an honest, spec'd
   decision not to attempt ACL preservation in v1. This should be written
   into the spec as a **chosen limitation**, not a discovered bug.
3. **Treat symlink-to-exFAT as a classified, expected error, not a
   crash-worthy surprise.** Since `copyfile.c` itself already treats a failed
   `symlink()` as fatal for that entry, the sync engine's per-file error
   handling / SafetyNet path needs a specific case for "source is a symlink,
   destination is exFAT" (or more generally, `symlink()` returning
   `ENOTSUP`/`EOPNOTSUPP`) — most likely: skip the entry, log/report it, and
   continue the batch, rather than aborting the whole sync run.
4. **Spec should explicitly document, per destination filesystem, exactly
   the matrix in §4** — particularly that POSIX permissions/ownership/ACLs
   on exFAT are inherently non-durable regardless of what flags are passed,
   that timestamp precision is degraded to exFAT's granularity, and that
   xattr/Finder-metadata preservation on exFAT is real but implemented via
   an invisible `._` sidecar file that only round-trips correctly through
   macOS's own xattr syscalls (a non-Mac reader, or a user manually copying
   the data file without its sidecar, loses it silently).
5. **If/when the spec wants proactive capability detection** (e.g., to warn
   the user before a sync run that the destination volume can't hold ACLs or
   symlinks, rather than discovering it file-by-file), the correct primitive
   is `getattrlist(2)`'s `ATTR_VOL_CAPABILITIES` (`vol_capabilities_attr_t`),
   checking bits like `VOL_CAP_FMT_SYMBOLICLINKS`, `VOL_CAP_FMT_HARDLINKS`,
   `VOL_CAP_FMT_NO_PERMISSIONS`, and `VOL_CAP_INT_EXTENDED_SECURITY` (ACLs) —
   *not* `VOL_CAP_INT_EXTENDED_ATTR`-gated `COPYFILE_PACK` logic. Per
   `getattrlist(2)`: *"`VOL_CAP_FMT_SYMBOLICLINKS` If this bit is set the
   volume format supports symbolic links."*, *"`VOL_CAP_FMT_NO_PERMISSIONS`
   If this bit is set, the volume format does not support setting file
   permissions."*, *"`VOL_CAP_INT_EXTENDED_SECURITY` If this bit is set the
   volume format implementation supports extended security controls
   (ACLs)."* This is a "Not yet specified" item to graduate later — v1 itself
   doesn't need to build this, since the two destination formats in scope
   (APFS, exFAT) are already fully characterized by the matrix above.

## Citations

- Apple `copyfile(3)` man page (local `man 3 copyfile`, macOS/Darwin) — flag
  definitions, `COPYFILE_PACK`/`COPYFILE_UNPACK`/`COPYFILE_CLONE` semantics.
- `copyfile.h`, [apple-oss-distributions/copyfile](https://github.com/apple-oss-distributions/copyfile/blob/main/copyfile.h)
  (identical to local `/usr/include/copyfile.h` from the CommandLineTools SDK)
  — flag bit values, `COPYFILE_ALL`/`COPYFILE_METADATA`/`COPYFILE_SECURITY` macros.
- `copyfile.c`, [apple-oss-distributions/copyfile](https://github.com/apple-oss-distributions/copyfile/blob/main/copyfile.c)
  — `copyfile_internal()` (flag dispatch order, PACK/UNPACK short-circuit),
  `copyfile_xattr()` (per-attribute `fsetxattr()` loop and error policy),
  `copyfile_stat()` (`fchown`/`fchmod`/`fsetattrlist`/BSD-flags ignore-errors
  policy), `copyfile_security()` (ACL apply warn-only policy), the symlink
  handling block (`readlink`/`symlink`, fatal-on-error), `copyfile_pack()`
  (AppleDouble blob construction and the `apple_double_header_t` layout
  comment), `copyfile_clone()` (same-volume-only clone).
- `bsd/vfs/vfs_xattr.c`, [apple-oss-distributions/xnu](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/vfs/vfs_xattr.c)
  — `vn_setxattr()`/`vn_getxattr()` (ENOTSUP → `default_setxattr`/`default_getxattr`
  fallback, unconditional unless `XATTR_NODEFAULT`), `default_setxattr_doubleagent()`
  (AppleDouble `._` sidecar creation via `doubleagentd`, `ATTR_FILE_PREFIX "._"`,
  FinderInfo/ResourceFork special-casing).
- `bsd/msdosfs/msdosfs_vnops.c`, [apple-oss-distributions/xnu](https://github.com/apple-oss-distributions/xnu)
  — confirms the FAT driver defines no `VNOP_GETXATTR`/`VNOP_SETXATTR`
  (used as the closest available public analogue for exFAT, whose own driver
  is closed-source; see the explicit caveat in §2).
- `setxattr(2)` man page (local `man 2 setxattr`) — `ENOTSUP` semantics
  ("The file system does not support extended attributes or has them
  disabled"), FinderInfo 32-byte size requirement.
- `getattrlist(2)` man page (local `man 2 getattrlist`) — `ATTR_VOL_CAPABILITIES`
  / `vol_capabilities_attr_t` bits: `VOL_CAP_FMT_SYMBOLICLINKS`,
  `VOL_CAP_FMT_HARDLINKS`, `VOL_CAP_FMT_NO_PERMISSIONS`,
  `VOL_CAP_INT_EXTENDED_SECURITY`, `VOL_CAP_INT_EXTENDED_ATTR`.
- `mount_exfat(8)` man page (local `man 8 mount_exfat`) — default
  `MNT_UNKNOWNPERMISSIONS` mount behavior absent explicit `-u/-g/-m`.
- GitHub API enumeration of the `apple-oss-distributions` org (via
  `api.github.com/orgs/apple-oss-distributions/repos`) — confirms no public
  `exfat` repository exists, only `copyfile`, `hfs`, `xnu`, etc.
- Corroborating (secondary, non-primary) real-world confirmation of the
  observable `._` sidecar behavior on FAT32/exFAT/network volumes:
  [Apple Support Communities — "Interoperability of FAT32, ex-FAT, HFS+…"](https://discussions.apple.com/thread/8197955),
  [Apple Support Communities — "Stop appledouble from creating on NAS"](https://discussions.apple.com/thread/5260367).
