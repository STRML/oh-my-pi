# OMP eval spawn gate. The prelude executes this source in its own namespace
# (not the user's), then calls `install`. Every subprocess the kernel would
# start is first sent to the host with its real argv, cwd and environment
# changes, and runs only after the host's bash gate approves it.
#
# Interception is a CPython audit hook (PEP 578). Hooks cannot be removed, and
# the events are raised by the C functions themselves, so a re-imported `os` or
# `posix`, a `getattr` with a computed name, or `importlib.reload` all reach the
# same hook. The C `fork_exec` behind `subprocess` is replaced by a wrapper that
# judges a snapshot of its arguments and hands the C function that snapshot; on
# 3.14+ a C `fork_exec` the wrapper did not vouch for is refused. Code the gate
# cannot see into is refused outright: native FFI (`ctypes`, `cffi`), native
# extension modules written after the omp session started, and
# subinterpreters, which run without this interpreter's audit hooks.
#
# Rules that keep the judged text equal to what runs:
# - Only exact `str`/`bytes` values (and exact `list`/`tuple` argv) are read.
#   A subclass could read one way to the gate and another way to C, so it is
#   refused. Where the gate makes the call itself (fork_exec) C gets the
#   gate's own snapshot; where it only observes (exec, posix_spawn) the
#   arguments are compared again after the verdict.
# - A spawn is never let through because its target looked missing: a target
#   that is not an executable file is refused with the error the call would
#   have raised (ENOENT/EACCES), so nothing runs and nothing needs judging.
# - argv[0] is shown as the file that will run whenever the startup PATH would
#   not pick that file for the name as written, and cwd is always absolute.
# - Every environment variable that differs from the kernel's startup
#   environment (set, changed or removed) travels with the request and leads
#   the judged command.
#
# Everything the gate needs is captured at install time, and the bridge client
# speaks HTTP over the C socket type with hand-built JSON, so monkeypatching
# `json`, `urllib`, `socket` or a prelude global cannot change what is judged.
# Handlers return an exception instead of raising, and the hook raises it from
# a frame that looks up no name, so a caught refusal's traceback reaches no
# gate state.

_HOOK_SOURCE = """
def hook(event, args, _dispatch=None):
    error = _dispatch(event, args)
    del _dispatch
    if error is None:
        return
    raise error
"""

# Installed in place of `_posixsubprocess.fork_exec` and `_imp.create_builtin`.
# They hold no reference to the gate (a closure would hand the gate's state to
# any cell that reads `__closure__`); they reach it through `sys.audit`, whose
# hook makes the call and returns the result in `box`.
_CALL_THROUGH_AUDIT_SOURCE = """
def call(*args, _audit=None, _event=None, **kwargs):
    box = []
    _audit(_event, args, kwargs, box)
    return box[0]
"""

# `subprocess` passes os.PathLike argv items, executables and cwd through to
# the C fork_exec. They are converted here, in the cell's own call and before
# the gate runs, so no cell-defined `__fspath__` ever runs inside the gate;
# the gate then accepts only exact str/bytes.
_FORK_EXEC_SOURCE = """
def fork_exec(*args, _audit=None, _fspath=None, _len=None, **kwargs):
    if _len(args) > 5:
        argv = [_fspath(a) for a in args[0]]
        executables = [_fspath(e) for e in args[1]]
        cwd = None if args[4] is None else _fspath(args[4])
        args = (argv, executables, args[2], args[3], cwd, *args[5:])
    box = []
    _audit("omp.spawn_gate.fork_exec", args, kwargs, box)
    return box[0]
"""

# Installed in place of os/posix execv, execve, posix_spawn and posix_spawnp.
# The copies are made here, in the cell's own call: path through os.fspath,
# argv into a tuple, env into a dict. The gate judges those copies and calls the
# C function with them, so a list or mapping the cell edits from another thread,
# or a mapping whose methods it replaced, cannot make C read something else.
_EXEC_SOURCE = """
def call(path, argv, env=None, *, _audit=None, _event=None, _kind=None, _fspath=None, _tuple=None, _dict=None, **kwargs):
    copied = (_kind, _fspath(path), _tuple(_fspath(a) for a in argv), None if env is None else _dict(env))
    box = []
    _audit(_event, copied, kwargs, box)
    return box[0]
"""

_NATIVE_CODE = "native FFI can load and call any libc function, so the eval kernel refuses it"

# Kernel-managed variables the runner rewrites per request; not cell changes.
_MANAGED_ENV = frozenset(
    {
        "PI_SESSION_FILE",
        "PI_ARTIFACTS_DIR",
        "PI_TOOL_BRIDGE_URL",
        "PI_TOOL_BRIDGE_TOKEN",
        "PI_TOOL_BRIDGE_SESSION",
        "PI_EVAL_LOCAL_ROOTS",
    }
)

# Subinterpreters start without this interpreter's audit hooks.
_SUBINTERPRETER_MODULES = frozenset(
    {"_interpreters", "_xxsubinterpreters", "_interpqueues", "_interpchannels", "concurrent.interpreters"}
)

# C modules a cell may not load a fresh copy of, under any package path or
# extension file name: FFI, the unwrapped fork_exec, subinterpreters, and the
# modules whose functions the audit hook relies on.
_BLOCKED_NATIVE = {
    "_ctypes": "native FFI can load and call any libc function, so the eval kernel refuses it",
    "_cffi_backend": "native FFI can load and call any libc function, so the eval kernel refuses it",
    "_posixsubprocess": "a fresh copy would carry the unwrapped C fork_exec",
    "_interpreters": "subinterpreters run without the spawn gate",
    "_xxsubinterpreters": "subinterpreters run without the spawn gate",
    "_interpqueues": "subinterpreters run without the spawn gate",
    "_interpchannels": "subinterpreters run without the spawn gate",
    "posix": "a fresh copy would bypass the gate",
    "nt": "a fresh copy would bypass the gate",
    "_winapi": "a fresh copy would bypass the gate",
}


def install(environ, run_id_getter, timeout=600.0, run_id_functions=()):
    """Install the hook. The bridge endpoint, token, startup environment and
    native-code epoch are pinned now, before any cell runs. The bridge session
    is read per spawn: it only selects which host registration judges, and a
    wrong one is refused."""
    import sys, os, _socket, _thread, _imp, time, _json, _collections_abc
    import importlib.machinery

    url = environ.get("PI_TOOL_BRIDGE_URL") or ""
    token = environ.get("PI_TOOL_BRIDGE_TOKEN") or ""
    env_of = environ.get
    host, port = "", 0
    if url.startswith("http://"):
        host, _, port_text = url[len("http://"):].rstrip("/").rpartition(":")
        port = int(port_text) if port_text.isdigit() else 0
    bridge_ready = bool(host and port and token)

    socket_type = _socket.socket
    af_inet, sock_stream = _socket.AF_INET, _socket.SOCK_STREAM
    getcwd, fspath, getpid, write, exit_now = os.getcwd, os.fspath, os.getpid, os.write, os._exit
    stat, lstat, access, x_ok, strerror = os.stat, os.lstat, os.access, os.X_OK, os.strerror
    environ_class = type(environ)
    # os.environ as the kernel started with it: what its instance dict holds,
    # by identity. The C call reads it through these and the classes below.
    environ_fields = dict(vars(environ))
    get_ident = _thread.get_ident
    install_pid = getpid()
    py_version = sys.version_info[:2]
    # C, not the json module: no cell-patchable Python runs inside the gate.
    scan_json_string = _json.scanstring
    extension_suffixes = tuple(importlib.machinery.EXTENSION_SUFFIXES)
    module_spec = importlib.machinery.ModuleSpec
    # Native extensions load only from the interpreter's own installation and
    # site directories, and only when their file predates this omp session: a
    # file changed since then may have been written by a cell.
    import site
    # Roots in resolved form, computed now, before any cell runs. A loaded path
    # must start with one and contain no symlink in any component, so it is
    # already its own realpath: nothing under a root can point outside it.
    extension_roots = []
    user_site = site.getusersitepackages()
    for root in (sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix, *site.getsitepackages(), user_site):
        if not root:
            continue
        resolved = os.path.realpath(root).rstrip("/") + "/"
        if resolved not in extension_roots:
            extension_roots.append(resolved)
    extension_roots = tuple(extension_roots)
    try:
        native_epoch = float(environ.get("PI_EVAL_GATE_EPOCH") or "")
    except ValueError:
        native_epoch = time.time()

    # Each root as it was when the gate installed: (st_dev, st_ino, st_ctime),
    # or None when it did not exist. A root created, replaced or changed since
    # (a directory renamed into place carries its old contents' ctimes) is no
    # longer trusted.
    def root_identity(root):
        try:
            info = os.lstat(root.rstrip("/"))
        except OSError:
            return None
        return (info.st_dev, info.st_ino, info.st_ctime)

    root_identities = {root: root_identity(root) for root in extension_roots}
    refused_prefix = "eval subprocess spawn refused"

    class SpawnRefused(PermissionError):
        pass

    class Refuse(Exception):
        """Raised inside gate code; `guarded` turns it into a SpawnRefused."""

    def text(value):
        """Trusted values only: the startup environment and the gate's snapshots."""
        if isinstance(value, (bytes, bytearray)):
            return bytes(value).decode("utf-8", "surrogateescape")
        return str(value)

    def exact_text(value, what):
        kind = type(value)
        if kind is str:
            return value
        if kind is bytes:
            return value.decode("utf-8", "surrogateescape")
        raise Refuse(f"{what} must be str or bytes, not {kind.__name__}")

    def exact_seq(value, what):
        if type(value) is not list and type(value) is not tuple:
            raise Refuse(f"{what} must be a list or tuple, not {type(value).__name__}")
        return tuple(value)

    def snapshot_word(value, what):
        """A word the gate passes on itself: exact str or bytes only (the
        wrapper already converted any os.PathLike, outside the gate)."""
        kind = type(value)
        if kind is str or kind is bytes:
            return value
        raise Refuse(f"{what} must be str or bytes, not {kind.__name__}")

    startup_env = {text(k): text(v) for k, v in environ.items()}
    # The process environment as the C library sees it: os.environ writes and
    # os.putenv/unsetenv all raise audit events that keep this current.
    live_env = dict(startup_env)
    startup_path = startup_env.get("PATH", "")

    # Runner housekeeping: listing child pids to stop an installer's process tree.
    internal = ("/bin/ps", ("/bin/ps", "-A", "-o", "pid=,ppid="))
    allowed_prefix = b'{"ok":true,"value":{"allowed":true'
    escapes = {i: "\\u%04x" % i for i in range(0x20)}
    escapes.update({ord('"'): '\\"', ord("\\"): "\\\\", 0x2028: "\\u2028", 0x2029: "\\u2029"})
    # fork_exec / exec / posix_spawn calls a wrapper vouched for, per thread:
    # the argv object it handed the C function.
    vouched = {}
    vouched_exec = {}
    original_exec = {}

    def json_str(value):
        return '"' + value.encode("utf-8", "surrogatepass").decode("utf-8", "replace").translate(escapes) + '"'

    def env_mapping(env):
        """The environment a spawn runs with, read only from exact types."""
        if env is None:
            return live_env
        out = {}
        if type(env) is dict:
            for key, value in tuple(env.items()):
                out[exact_text(key, "env name")] = exact_text(value, "env value")
            return out
        if env is environ:
            # The C call reads os.environ through its keys()/values(). Its
            # class and the collections.abc views are protected from change, so
            # an unchanged instance dict means C reads exactly its `_data`.
            fields = vars(environ)
            if type(environ) is not environ_class or fields.keys() != environ_fields.keys():
                raise Refuse("os.environ has been altered; pass a dict")
            for name, original in environ_fields.items():
                if name != "_data" and fields[name] is not original:
                    raise Refuse("os.environ has been altered; pass a dict")
            data = fields["_data"]
            if type(data) is not dict:
                raise Refuse("os.environ has been altered; pass a dict")
            for key, value in tuple(data.items()):
                out[exact_text(key, "env name")] = exact_text(value, "env value")
            return out
        for item in exact_seq(env, "env (a dict, os.environ, or a list of NAME=value)"):
            name, sep, value = exact_text(item, "env entry").partition("=")
            if not sep:
                continue
            if name in out:
                # The gate would keep one value and getenv() in the child the other.
                raise Refuse(f"env lists {name} twice")
            out[name] = value
        return out

    def env_snapshot(env):
        if env is None:
            return None
        if type(env) is dict:
            return tuple(env.items())
        if env is environ:
            return tuple(vars(environ)["_data"].items())
        return tuple(env)

    def env_change(env):
        """(set or changed, removed) relative to the startup environment."""
        changed = {}
        for name, value in env.items():
            if name in _MANAGED_ENV:
                continue
            if startup_env.get(name) == value:
                continue
            if name.startswith("BASH_FUNC_"):
                raise Refuse(f"exported shell function {name} would run inside any bash the spawn starts")
            changed[name] = value
        removed = [name for name in startup_env if name not in env and name not in _MANAGED_ENV]
        return changed, removed

    def is_executable(candidate):
        try:
            return (stat(candidate).st_mode & 0o170000) == 0o100000 and access(candidate, x_ok)
        except (OSError, ValueError):
            return False

    def missing(path):
        """The error exec raises for a target that is not an executable file."""
        try:
            stat(path)
        except (OSError, ValueError):
            return FileNotFoundError(2, strerror(2), path)
        return PermissionError(13, strerror(13), path)

    def absolute(path, base):
        return path if path.startswith("/") else base.rstrip("/") + "/" + path

    def resolve(name, search_path, base):
        """The file an exec-p call would run for `name` under `search_path`."""
        if "/" in name:
            return absolute(name, base)
        for directory in search_path.split(":"):
            full = absolute((directory or ".") + "/" + name, base)
            if is_executable(full):
                return full
        return None

    def display_argv(executed, argv):
        """argv[0] stays as written only when the startup PATH resolves it to
        the file that runs; otherwise it becomes that file's path."""
        argv = list(argv)
        if not argv:
            return [executed]
        if argv[0] != executed and ("/" in argv[0] or resolve(argv[0], startup_path, getcwd()) != executed):
            argv[0] = executed
        return argv

    def refusal(api, reason):
        # A host refusal already names itself; don't stack a second prefix on it.
        message = reason if reason.startswith(refused_prefix) else f"{refused_prefix} ({api}): {reason}"
        if api == "os.exec" and getpid() != install_pid:
            # A forked child whose exec is refused must not fall back into the
            # kernel's own code (pty.spawn, os.spawn* and hand-rolled fork+exec
            # all do on an exec error), so it ends here.
            write(2, (message + "\n").encode("utf-8", "replace"))
            exit_now(126)
        return SpawnRefused(message)

    def post(body):
        conn = socket_type(af_inet, sock_stream)
        try:
            conn.settimeout(timeout)
            conn.connect((host, port))
            head = (
                "POST /v1/tool HTTP/1.1\r\nHost: %s:%d\r\nAuthorization: Bearer %s\r\n"
                "Content-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n"
                % (host, port, token, len(body))
            )
            conn.sendall(head.encode("ascii") + body)
            chunks = []
            while True:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                chunks.append(chunk)
        finally:
            conn.close()
        return b"".join(chunks)

    def judge(api, env, argv=None, command=None, cwd=None, program=None):
        """None when the host allows the spawn, else the refusal to return.
        Text arguments are already exact; `env` is the full environment the
        spawn runs with."""
        if not bridge_ready:
            return refusal(api, "no host bridge in this kernel")
        changed, removed = env_change(env)
        run = run_id_getter()
        run = run if type(run) is str else ""
        fields = [
            '"session":' + json_str(text(env_of("PI_TOOL_BRIDGE_SESSION") or "")),
            '"run":' + json_str(run),
            '"name":"__spawn__"',
        ]
        request = ['"api":' + json_str(api), '"cwd":' + json_str(cwd if cwd is not None else getcwd())]
        if command is not None:
            request.append('"command":' + json_str(command))
        else:
            request.append('"argv":[' + ",".join(json_str(arg) for arg in argv) + "]")
        if program is not None:
            request.append('"program":' + json_str(program))
        if changed:
            request.append('"env":{' + ",".join(json_str(k) + ":" + json_str(v) for k, v in changed.items()) + "}")
        if removed:
            request.append('"unset":[' + ",".join(json_str(k) for k in removed) + "]")
        body = ("{" + ",".join(fields) + ',"args":{' + ",".join(request) + "}}").encode("utf-8")
        try:
            response = post(body)
        except OSError as exc:
            return refusal(api, f"host bridge unreachable: {exc}")
        head, _, payload = response.partition(b"\r\n\r\n")
        if head.startswith((b"HTTP/1.1 200 ", b"HTTP/1.0 200 ")) and payload.startswith(allowed_prefix):
            return None
        reason = "malformed host verdict"
        body_text = payload.decode("utf-8", "replace")
        start = body_text.find('"error":"')
        if start >= 0:
            try:
                reason = scan_json_string(body_text, start + len('"error":"'))[0] or "denied"
            except ValueError:
                pass
        return refusal(api, reason)

    def judge_executable(api, executed, argv, cwd, env):
        """Judge running the file `executed` (absolute) with `argv` (exact text)."""
        if not is_executable(executed):
            return missing(executed)
        shown = display_argv(executed, argv)
        if (executed, tuple(shown)) == internal and env_change(env) == ({}, []):
            return None
        return judge(api, env, argv=shown, cwd=cwd, program=executed)

    def check_fork_exec(args):
        """The fork_exec arguments to run: argv, executable, cwd and env are the
        gate's own snapshots, the executable list narrowed to the one file
        judged and cwd made absolute; or the refusal."""
        if len(args) < 6:
            raise Refuse("malformed fork_exec call")
        argv = [snapshot_word(a, "argv item") for a in exact_seq(args[0], "argv")]
        candidates = [snapshot_word(c, "executable") for c in exact_seq(args[1], "executable list")]
        cwd = getcwd() if args[4] is None else absolute(text(snapshot_word(args[4], "cwd")), getcwd())
        env = None if args[5] is None else [snapshot_word(e, "env entry") for e in exact_seq(args[5], "env")]
        argv_text = [text(a) for a in argv]
        env_full = env_mapping(env)
        for candidate in candidates:
            full = absolute(text(candidate), cwd)
            if is_executable(full):
                error = judge_executable("subprocess", full, argv_text, cwd, env_full)
                if error is not None:
                    return error
                executable = (full.encode("utf-8", "surrogateescape"),)
                return (argv, executable, args[2], args[3], cwd, env, *args[6:])
        return FileNotFoundError(2, strerror(2), argv_text[0] if argv_text else "")

    def on_fork_exec_call(args):
        call_args, call_kwargs, box = args
        if type(call_args) is not tuple or type(call_kwargs) is not dict or call_kwargs or type(box) is not list:
            return refusal("subprocess", "malformed fork_exec call")
        outcome = check_fork_exec(call_args)
        if isinstance(outcome, BaseException):
            return outcome
        ident = get_ident()
        vouched[ident] = outcome[0]
        try:
            box.append(original_fork_exec(*outcome))
        except BaseException as exc:
            error = exc.with_traceback(None)
            del exc
            return error
        finally:
            vouched.pop(ident, None)
        return None

    def on_fork_exec_event(args):
        # 3.14+: only a call the wrapper judged may proceed. Anything else
        # reached the raw C function, whose cwd the event does not carry.
        if vouched.get(get_ident()) is args[1]:
            return None
        return refusal("_posixsubprocess.fork_exec", "called outside subprocess; its cwd cannot be judged")

    def observed(path, argv, env):
        """Exact-type readings of a Windows os.spawn* call, which the gate only observes."""
        path_text = exact_text(path, "executable path")
        argv_text = [exact_text(a, "argv item") for a in exact_seq(argv, "argv")]
        return path_text, argv_text, env_mapping(env), (tuple(argv), env_snapshot(env))

    def unchanged(api, error, before, argv, env):
        if error is not None:
            return error
        if before[0] != tuple(argv) or before[1] != env_snapshot(env):
            return refusal(api, "the arguments changed while the spawn was being judged")
        return None

    def on_system(args):
        return judge("os.system", live_env, command=exact_text(args[0], "command"))

    def exec_call(api, args):
        """A call through the exec/posix_spawn wrappers: the wrapper already
        copied path, argv and env out of cell objects; the C function gets
        exactly these copies, so nothing can change between judging and use."""
        call_args, call_kwargs, box = args
        if type(call_args) is not tuple or type(call_kwargs) is not dict or type(box) is not list:
            raise Refuse("malformed call")
        if len(call_args) != 4:
            raise Refuse("malformed call")
        kind, path, argv, env = call_args
        path_text = exact_text(path, "executable path")
        argv_seq = exact_seq(argv, "argv")
        argv_text = [exact_text(a, "argv item") for a in argv_seq]
        if env is not None and type(env) is not dict:
            raise Refuse("malformed call")
        # The wrapper's own copy is only as good as its keyword defaults, which a
        # caller can override (`_dict=lambda e: e`); the gate copies again, from
        # an exact dict, and C gets that copy.
        if env is not None:
            env = env.copy()
        env_full = env_mapping(env)
        if kind == "posix_spawnp" and "/" not in path_text:
            # The C library searches the caller's PATH; require the PATH the
            # call passes to agree, then run the resolved file directly.
            executed = resolve(path_text, live_env.get("PATH", ""), getcwd())
            if resolve(path_text, env_full.get("PATH", ""), getcwd()) != executed:
                return refusal(api, "posix_spawnp resolves differently under the PATH it was passed")
            if executed is None:
                return FileNotFoundError(2, strerror(2), path_text)
        else:
            executed = absolute(path_text, getcwd())
        error = judge_executable(api, executed, argv_text, None, env_full)
        if error is not None:
            return error
        target = original_exec[kind if kind != "posix_spawnp" else "posix_spawn"]
        ident = get_ident()
        vouched_exec[ident] = argv_seq
        try:
            if kind in ("execv",):
                box.append(target(executed, argv_seq))
            elif kind == "execve":
                box.append(target(executed, argv_seq, env))
            else:
                box.append(target(executed, argv_seq, env, **call_kwargs))
        except BaseException as exc:
            failure = exc.with_traceback(None)
            del exc
            return failure
        finally:
            vouched_exec.pop(ident, None)
        return None

    def on_exec_call(args):
        return exec_call("os.exec", args)

    def on_posix_spawn_call(args):
        return exec_call("os.posix_spawn", args)

    def on_exec_event(args):
        # The C call checks in through the wrapper; anything else reached the
        # raw C function with arguments the gate never copied.
        if vouched_exec.get(get_ident()) is args[1]:
            return None
        return refusal("os.exec", "called outside the spawn gate's wrapper")

    def on_posix_spawn_event(args):
        if vouched_exec.get(get_ident()) is args[1]:
            return None
        return refusal("os.posix_spawn", "called outside the spawn gate's wrapper")

    def on_spawn(args):
        _mode, path, argv, env = args
        path_text, argv_text, env_full, before = observed(path, argv, env)
        error = judge("os.spawn", env_full, argv=display_argv(path_text, argv_text), program=path_text)
        return unchanged("os.spawn", error, before, argv, env)

    def on_create_process(args):
        application, command_line, cwd = args[0], args[1], args[2]
        command = exact_text(command_line if command_line is not None else application, "command line")
        return judge(
            "_winapi.CreateProcess", live_env, command=command, cwd=None if cwd is None else exact_text(cwd, "cwd")
        )

    def on_putenv(args):
        live_env[text(args[0])] = text(args[1])

    def on_unsetenv(args):
        live_env.pop(text(args[0]), None)

    def on_ffi(args):
        return SpawnRefused(f"{refused_prefix} (ctypes): {_NATIVE_CODE}")

    def blocked(name):
        # By last dotted component, so `pkg._ctypes` is no way around it.
        reason = _BLOCKED_NATIVE.get(name.rpartition(".")[2])
        return SpawnRefused(f"{refused_prefix} ({name}): {reason}") if reason else None

    def on_import(args):
        name = exact_text(args[0], "module name") if args else ""
        if name == "concurrent.interpreters":
            return SpawnRefused(f"{refused_prefix} ({name}): subinterpreters run without the spawn gate")
        error = blocked(name)
        if error is not None:
            return error
        filename = args[1] if len(args) > 1 else None
        if filename is None:
            return None
        # Only a native extension load carries a filename on this event, however
        # it was reached (import, ExtensionFileLoader, _imp.create_dynamic), so
        # every filename is checked, whatever its suffix.
        path = exact_text(filename, "extension path")
        error = blocked(path.rpartition("/")[2].partition(".")[0])
        if error is not None:
            return error
        if not path.startswith("/") or "/./" in path or "/../" in path:
            return SpawnRefused(f"{refused_prefix} (native extension): {path} is not a plain absolute path")
        if not path.startswith(extension_roots):
            return SpawnRefused(
                f"{refused_prefix} (native extension): {path} is outside the interpreter's install and site directories"
            )
        # Every matching root must be the same directory it was at install, and
        # the epoch check starts at the outermost one, the root itself included.
        root_length = len(path)
        for root in extension_roots:
            if not path.startswith(root):
                continue
            recorded = root_identities[root]
            if recorded is None:
                return SpawnRefused(
                    f"{refused_prefix} (native extension): {root} did not exist when the spawn gate installed"
                )
            try:
                info = lstat(root.rstrip("/"))
            except (OSError, ValueError):
                return SpawnRefused(f"{refused_prefix} (native extension): cannot stat {root}")
            if (info.st_dev, info.st_ino, info.st_ctime) != recorded:
                return SpawnRefused(
                    f"{refused_prefix} (native extension): {root} changed after the spawn gate installed; "
                    "restart omp to load extensions from it"
                )
            root_length = min(root_length, len(root) - 1)
        prefix = ""
        for part in path.split("/")[1:]:
            prefix += "/" + part
            try:
                info = lstat(prefix)
            except (OSError, ValueError):
                return SpawnRefused(f"{refused_prefix} (native extension): cannot stat {prefix}")
            if (info.st_mode & 0o170000) == 0o120000:
                return SpawnRefused(f"{refused_prefix} (native extension): {prefix} is a symlink")
            # Every component below the root, not just the file: renaming a
            # directory under a root changes only that directory's ctime, so an
            # old file inside it would otherwise pass.
            if len(prefix) >= root_length and info.st_ctime >= native_epoch:
                return SpawnRefused(
                    f"{refused_prefix} (native extension): {prefix} changed during this omp session, "
                    "so a cell may have written it; restart omp to load newly installed extensions"
                )
        return None

    def on_new_interpreter(args):
        return SpawnRefused(f"{refused_prefix} (subinterpreter): subinterpreters run without the spawn gate")

    def on_create_builtin_call(args):
        call_args, call_kwargs, box = args
        if type(call_args) is not tuple or len(call_args) != 1 or call_kwargs or type(box) is not list:
            return refusal("_imp.create_builtin", "malformed call")
        spec = call_args[0]
        # An exact ModuleSpec, whose class cannot be changed (protected below),
        # keeps `name` in its instance dict: reading it runs no cell code.
        if type(spec) is not module_spec:
            return refusal("_imp.create_builtin", "the spec must be an importlib ModuleSpec")
        name = exact_text(vars(spec).get("name"), "module name")
        error = blocked(name)
        if error is not None:
            return error
        box.append(original_create_builtin(module_spec(name, None)))
        return None

    def on_introspect(args):
        # These reach live gate frames, which is how a cell would rewrite what
        # the gate judges.
        return PermissionError("eval kernel: this introspection is disabled by the spawn gate")

    # Threads currently inside the gate. Frame access is refused for them only:
    # the gate calls no cell code, but a signal handler can still run there.
    in_gate = {}

    def on_frame_access(args):
        # Depth 1 is this very event's dispatch; more means gate code was already running.
        if in_gate.get(get_ident(), 0) > 1:
            return PermissionError("eval kernel: frame access is disabled inside the spawn gate")
        return None

    protected = set()

    def on_setattr(args):
        if id(args[0]) in protected:
            return PermissionError("eval kernel: the spawn gate cannot be modified")
        return None

    handlers = {
        "os.system": on_system,
        "os.exec": on_exec_event,
        "os.posix_spawn": on_posix_spawn_event,
        "omp.spawn_gate.exec": on_exec_call,
        "omp.spawn_gate.posix_spawn": on_posix_spawn_call,
        "os.spawn": on_spawn,
        "os.putenv": on_putenv,
        "os.unsetenv": on_unsetenv,
        "_winapi.CreateProcess": on_create_process,
        "ctypes.dlopen": on_ffi,
        "ctypes.dlsym": on_ffi,
        "ctypes.dlsym/handle": on_ffi,
        "ctypes.call_function": on_ffi,
        "import": on_import,
        "cpython.PyInterpreterState_New": on_new_interpreter,
        "object.__setattr__": on_setattr,
        "gc.get_referrers": on_introspect,
        "gc.get_referents": on_introspect,
        "gc.get_objects": on_introspect,
        "sys._current_frames": on_introspect,
        "sys.settrace": on_introspect,
        "sys.setprofile": on_introspect,
        "sys._settraceallthreads": on_introspect,
        "sys._setprofileallthreads": on_introspect,
        "sys.monitoring.register_callback": on_introspect,
        "sys._getframe": on_frame_access,
        "sys._getframemodulename": on_frame_access,
    }

    def guarded(fn, *args):
        """Run gate code; any failure becomes a refusal, and no gate frame escapes."""
        try:
            return fn(*args)
        except KeyboardInterrupt:
            return KeyboardInterrupt()
        except Refuse as exc:
            error = SpawnRefused(f"{refused_prefix}: {exc}")
            del exc
            return error
        except BaseException as exc:
            error = SpawnRefused(f"{refused_prefix}: gate error {type(exc).__name__}: {exc}")
            del exc
            return error

    def dispatch(event, args):
        handler = handlers.get(event)
        if handler is None:
            return None
        ident = get_ident()
        depth = in_gate.get(ident, 0)
        in_gate[ident] = depth + 1
        try:
            return guarded(handler, args)
        finally:
            if depth:
                in_gate[ident] = depth
            else:
                in_gate.pop(ident, None)

    def closure_free(source, name, kwdefaults):
        scope = {"__builtins__": {}}
        exec(source, scope)
        fn = scope.pop(name)
        fn.__kwdefaults__ = kwdefaults
        protected.add(id(fn))
        protected.add(id(fn.__code__))
        return fn

    def call_through_audit(event):
        return closure_free(_CALL_THROUGH_AUDIT_SOURCE, "call", {"_audit": sys.audit, "_event": event})

    try:
        import _posixsubprocess, subprocess
    except ImportError:
        _posixsubprocess = subprocess = None
    original_fork_exec = None
    if _posixsubprocess is not None:
        original_fork_exec = _posixsubprocess.fork_exec
        gated_fork_exec = closure_free(_FORK_EXEC_SOURCE, "fork_exec", {"_audit": sys.audit, "_fspath": fspath, "_len": len})
        # Both bindings: `subprocess` captured its own at import, and
        # multiprocessing looks the module attribute up at call time.
        _posixsubprocess.fork_exec = gated_fork_exec
        if subprocess is not None and hasattr(subprocess, "_fork_exec"):
            subprocess._fork_exec = gated_fork_exec
        handlers["omp.spawn_gate.fork_exec"] = on_fork_exec_call

    try:
        import posix
    except ImportError:
        posix = None
    for kind in ("execv", "execve", "posix_spawn", "posix_spawnp") if posix is not None else ():
        original = getattr(posix, kind, None)
        if original is None:
            continue
        original_exec[kind] = original
        event = "omp.spawn_gate.exec" if kind.startswith("exec") else "omp.spawn_gate.posix_spawn"
        wrapper = closure_free(
            _EXEC_SOURCE,
            "call",
            {"_audit": sys.audit, "_event": event, "_kind": kind, "_fspath": fspath, "_tuple": tuple, "_dict": dict},
        )
        # os.execvp/execlp/spawnv and pty.spawn look these up in os at call time.
        setattr(posix, kind, wrapper)
        setattr(os, kind, wrapper)
        if py_version >= (3, 14):
            handlers["_posixsubprocess.fork_exec"] = on_fork_exec_event

    # A subinterpreter runs without this interpreter's audit hooks. Importing
    # the modules that create one is refused above; one already loaded (the
    # stdlib's concurrent.futures imports `_interpreters`) loses its functions.
    def on_subinterpreter_call(args):
        return SpawnRefused(f"{refused_prefix} (subinterpreter): subinterpreters run without the spawn gate")

    handlers["omp.spawn_gate.subinterpreter"] = on_subinterpreter_call
    refuse_subinterpreter = call_through_audit("omp.spawn_gate.subinterpreter")
    for name in _SUBINTERPRETER_MODULES:
        module = sys.modules.get(name)
        if module is None:
            continue
        for attribute, value in tuple(vars(module).items()):
            if type(value).__name__ == "builtin_function_or_method":
                setattr(module, attribute, refuse_subinterpreter)

    original_create_builtin = _imp.create_builtin
    _imp.create_builtin = call_through_audit("omp.spawn_gate.create_builtin")
    handlers["omp.spawn_gate.create_builtin"] = on_create_builtin_call

    # Classes whose methods the gate or a C call relies on without calling cell
    # code: setting an attribute on them is refused. The runner's run-id getter
    # runs inside the gate, so its code is fixed too.
    for cls in (
        module_spec,
        environ_class,
        _collections_abc.Mapping,
        _collections_abc.MutableMapping,
        _collections_abc.KeysView,
        _collections_abc.ValuesView,
        _collections_abc.ItemsView,
    ):
        protected.add(id(cls))
    for fn in run_id_functions:
        protected.add(id(fn))
        protected.add(id(fn.__code__))

    hook_globals = {"__builtins__": {}}
    exec(_HOOK_SOURCE, hook_globals)
    hook = hook_globals.pop("hook")
    hook.__defaults__ = (dispatch,)
    gate_functions = (hook, dispatch, guarded, judge, judge_executable, check_fork_exec, post, text, json_str)
    for fn in (*gate_functions, display_argv, refusal, observed, unchanged, exec_call, *handlers.values()):
        protected.add(id(fn))
        protected.add(id(fn.__code__))
    sys.addaudithook(hook)
    return bridge_ready
