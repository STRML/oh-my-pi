# OMP eval spawn gate. The prelude executes this source in its own namespace
# (not the user's), then calls `install`. Every subprocess the kernel would
# start is first sent to the host with its real argv, cwd and changed
# execution-affecting environment, and runs only after the host's bash gate
# approves it.
#
# Interception is a CPython audit hook (PEP 578). Hooks cannot be removed, and
# the events are raised by the C functions themselves, so a re-imported `os`,
# `posix` or `_posixsubprocess`, a `getattr` with a computed name, or
# `importlib.reload` all reach the same hook. The C `fork_exec` behind
# `subprocess` gets a wrapper as well, because its audit event (3.14+) carries
# no cwd; on 3.14+ a `fork_exec` that did not come through the wrapper is
# refused. Native FFI is refused outright: a `ctypes`/`cffi` call has no argv
# to judge.
#
# Rules that keep the judged text equal to what runs:
# - A spawn is never let through because its target looked missing. A target
#   that is not an executable file is refused with the error the call would
#   have raised (ENOENT/EACCES), so nothing runs and nothing needs judging.
# - argv[0] is shown as the file that will run whenever the startup PATH would
#   not pick that file for the name as written.
# - Execution-affecting variables that differ from the kernel's startup
#   environment travel with the request and lead the judged command.
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

# Installed as `_posixsubprocess.fork_exec`. It holds no reference to the
# gate (a closure would hand the gate's state to any cell that reads
# `fork_exec.__closure__`); it reaches the gate through `sys.audit`, whose hook
# runs the judged call and returns the pid in `box`.
_FORK_EXEC_SOURCE = """
def fork_exec(*args, _audit=None, **kwargs):
    box = []
    _audit("omp.spawn_gate.fork_exec", args, kwargs, box)
    return box[0]
"""

_NATIVE_CODE = "native FFI can load and call any libc function, so the eval kernel refuses it"

# Variables that change which program runs or what it loads, beyond its argv.
_WATCHED_ENV = frozenset(
    {
        "PATH",
        "BASH_ENV",
        "ENV",
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "NODE_OPTIONS",
        "PYTHONSTARTUP",
        "PYTHONPATH",
        "GIT_SSH",
        "GIT_SSH_COMMAND",
        "GIT_EXEC_PATH",
        "PERL5OPT",
        "RUBYOPT",
    }
)
_WATCHED_ENV_PREFIXES = ("DYLD_",)


def install(environ, run_id_getter, timeout=600.0):
    """Install the hook. The bridge endpoint, token and startup environment are
    pinned now, before any cell runs, so a cell cannot point the gate at a
    server of its own or move what counts as a changed variable. The bridge
    session is read per spawn: it only selects which host registration judges,
    and a wrong one is refused."""
    import sys, os, _socket, _thread

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
    stat, access, x_ok, strerror = os.stat, os.access, os.X_OK, os.strerror
    environ_type = type(environ)
    get_ident = _thread.get_ident
    install_pid = getpid()
    py_version = sys.version_info[:2]
    json_loads = __import__("json").loads  # Error text only; never decides a verdict.

    def text(value):
        value = fspath(value) if not isinstance(value, (str, bytes, bytearray)) else value
        if isinstance(value, (bytes, bytearray)):
            return bytes(value).decode("utf-8", "surrogateescape")
        return str(value)

    startup_env = {text(k): text(v) for k, v in environ.items()}
    # The process environment as the C library sees it: os.environ writes and
    # os.putenv/unsetenv all raise audit events that keep this current.
    live_env = dict(startup_env)
    startup_path = startup_env.get("PATH", "")

    # Runner housekeeping: listing child pids to stop an installer's process tree.
    internal = ("/bin/ps", ("/bin/ps", "-A", "-o", "pid=,ppid="))
    refused_prefix = "eval subprocess spawn refused"
    allowed_prefix = b'{"ok":true,"value":{"allowed":true'
    escapes = {i: "\\u%04x" % i for i in range(0x20)}
    escapes.update({ord('"'): '\\"', ord("\\"): "\\\\", 0x2028: "\\u2028", 0x2029: "\\u2029"})
    # fork_exec calls the wrapper vouched for, per thread: the argv it passed on.
    vouched = {}

    class SpawnRefused(PermissionError):
        pass

    def json_str(value):
        return '"' + value.encode("utf-8", "surrogatepass").decode("utf-8", "replace").translate(escapes) + '"'

    def is_watched(name):
        return name in _WATCHED_ENV or name.startswith(_WATCHED_ENV_PREFIXES)

    def env_mapping(env):
        """The environment a spawn runs with, as text, or None if it cannot be
        read without asking cell code (a mapping type the gate does not know)."""
        if env is None:
            return live_env
        if type(env) is dict or type(env) is environ_type:
            return {text(k): text(v) for k, v in env.items()}
        if type(env) in (list, tuple):
            out = {}
            for item in env:
                name, sep, value = text(item).partition("=")
                if sep:
                    out[name] = value
            return out
        return None

    def env_delta(env):
        return {k: v for k, v in env.items() if is_watched(k) and startup_env.get(k) != v}

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

    def resolve(name, search_path, base):
        """The file an exec-p call would run for `name` under `search_path`."""
        if "/" in name:
            return name
        for directory in search_path.split(":"):
            candidate = (directory or ".") + "/" + name
            full = candidate if candidate.startswith("/") else base + "/" + candidate
            if is_executable(full):
                return full
        return None

    def display_argv(executed, args):
        """argv[0] stays as written only when the startup PATH resolves it to
        the file that runs; otherwise it becomes that file's path, so a PATH
        hijack or an `executable=` override shows."""
        argv = [text(arg) for arg in (args or ())]
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

    def judge(api, argv=None, command=None, cwd=None, env=None):
        """None when the host allows the spawn, else the refusal to raise."""
        if not bridge_ready:
            return refusal(api, "no host bridge in this kernel")
        spawn_env = env_mapping(env)
        if spawn_env is None:
            return refusal(api, "the spawn environment must be a dict or os.environ")
        delta = env_delta(spawn_env)
        cwd = text(cwd) if cwd is not None else getcwd()
        run = run_id_getter()
        fields = [
            '"session":' + json_str(text(env_of("PI_TOOL_BRIDGE_SESSION") or "")),
            '"run":' + json_str(text(run) if run is not None else ""),
            '"name":"__spawn__"',
        ]
        request = ['"api":' + json_str(api), '"cwd":' + json_str(cwd)]
        if command is not None:
            request.append('"command":' + json_str(command))
        else:
            request.append('"argv":[' + ",".join(json_str(arg) for arg in argv) + "]")
        if delta:
            request.append('"env":{' + ",".join(json_str(k) + ":" + json_str(v) for k, v in delta.items()) + "}")
        body = ("{" + ",".join(fields) + ',"args":{' + ",".join(request) + "}}").encode("utf-8")
        try:
            response = post(body)
        except OSError as exc:
            return refusal(api, f"host bridge unreachable: {exc}")
        head, _, payload = response.partition(b"\r\n\r\n")
        if head.startswith((b"HTTP/1.1 200 ", b"HTTP/1.0 200 ")) and payload.startswith(allowed_prefix):
            return None
        try:
            reason = json_loads(payload).get("error") or "denied"
        except Exception:
            reason = "malformed host verdict"
        return refusal(api, reason)

    def judge_executable(api, executed, args, cwd=None, env=None):
        if not is_executable(executed):
            return missing(executed)
        argv = display_argv(executed, args)
        if (executed, tuple(argv)) == internal:
            spawn_env = env_mapping(env)
            if spawn_env is not None and not env_delta(spawn_env):
                return None
        return judge(api, argv=argv, cwd=cwd, env=env)

    def check_fork_exec(args):
        """The fork_exec arguments to run (executable list narrowed to the one
        file judged) or the refusal. Relative candidates resolve against the
        cwd the child will chdir to before exec."""
        argv, candidates, cwd, env = args[0], args[1], args[4], args[5]
        base = text(cwd) if cwd is not None else getcwd()
        for candidate in candidates or ():
            path = text(candidate)
            full = path if path.startswith("/") else base + "/" + path
            if is_executable(full):
                error = judge_executable("subprocess", full, argv, cwd=base, env=env)
                return error if error is not None else (argv, (candidate,), *args[2:])
        return FileNotFoundError(2, strerror(2), text(argv[0]) if argv else "")

    def on_fork_exec_call(args):
        call_args, call_kwargs, box = args
        if type(call_args) is not tuple or type(call_kwargs) is not dict or type(box) is not list:
            return refusal("subprocess", "malformed fork_exec call")
        outcome = check_fork_exec(call_args)
        if isinstance(outcome, BaseException):
            return outcome
        ident = get_ident()
        vouched[ident] = outcome[0]
        try:
            box.append(original_fork_exec(*outcome, **call_kwargs))
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

    def on_system(args):
        return judge("os.system", command=text(args[0]))

    def on_exec(args):
        path = text(args[0])
        full = path if path.startswith("/") else getcwd() + "/" + path
        return judge_executable("os.exec", full, args[1], env=args[2])

    def on_posix_spawn(args):
        path, env = text(args[0]), args[2]
        if "/" in path:
            return judge_executable("os.posix_spawn", path if path.startswith("/") else getcwd() + "/" + path, args[1], env=env)
        # posix_spawnp: the C library searches the caller's PATH; require the
        # PATH the call passes to agree, so there is one answer to judge.
        spawn_env = env_mapping(env)
        passed_path = spawn_env.get("PATH", "") if spawn_env is not None else None
        executed = resolve(path, live_env.get("PATH", ""), getcwd())
        if passed_path is not None and resolve(path, passed_path, getcwd()) != executed:
            return refusal("os.posix_spawn", "posix_spawnp resolves differently under the PATH it was passed")
        if executed is None:
            return FileNotFoundError(2, strerror(2), path)
        return judge_executable("os.posix_spawn", executed, args[1], env=env)

    def on_spawn(args):
        return judge("os.spawn", argv=display_argv(text(args[1]), args[2]), env=args[3])

    def on_create_process(args):
        return judge("_winapi.CreateProcess", command=text(args[1] or args[0]), cwd=args[2])

    def on_putenv(args):
        live_env[text(args[0])] = text(args[1])

    def on_unsetenv(args):
        live_env.pop(text(args[0]), None)

    def on_ffi(args):
        return SpawnRefused(f"{refused_prefix} (ctypes): {_NATIVE_CODE}")

    def on_import(args):
        if args and args[0] in ("_ctypes", "_cffi_backend"):
            return SpawnRefused(f"{refused_prefix} ({args[0]}): {_NATIVE_CODE}")
        if args and args[0] == "_posixsubprocess":
            # A fresh copy would carry the unwrapped C fork_exec.
            return SpawnRefused(f"{refused_prefix} (_posixsubprocess): re-importing it would bypass the gate")
        return None

    def on_introspect(args):
        # These reach live gate frames, which is how a cell would rewrite what
        # the gate judges.
        return PermissionError("eval kernel: this introspection is disabled by the spawn gate")

    protected = set()

    def on_setattr(args):
        if id(args[0]) in protected:
            return PermissionError("eval kernel: the spawn gate cannot be modified")
        return None

    handlers = {
        "os.system": on_system,
        "os.exec": on_exec,
        "os.posix_spawn": on_posix_spawn,
        "os.spawn": on_spawn,
        "os.putenv": on_putenv,
        "os.unsetenv": on_unsetenv,
        "_winapi.CreateProcess": on_create_process,
        "ctypes.dlopen": on_ffi,
        "ctypes.dlsym": on_ffi,
        "ctypes.dlsym/handle": on_ffi,
        "ctypes.call_function": on_ffi,
        "import": on_import,
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
    }

    def guarded(fn, *args):
        """Run gate code; any failure becomes a refusal, and no gate frame escapes."""
        try:
            return fn(*args)
        except KeyboardInterrupt:
            return KeyboardInterrupt()
        except BaseException as exc:
            error = SpawnRefused(f"{refused_prefix}: gate error {type(exc).__name__}: {exc}")
            del exc
            return error

    def dispatch(event, args):
        handler = handlers.get(event)
        return None if handler is None else guarded(handler, args)

    try:
        import _posixsubprocess, subprocess
    except ImportError:
        _posixsubprocess = subprocess = None
    original_fork_exec = None
    if _posixsubprocess is not None:
        original_fork_exec = _posixsubprocess.fork_exec
        wrapper_globals = {"__builtins__": {}}
        exec(_FORK_EXEC_SOURCE, wrapper_globals)
        gated_fork_exec = wrapper_globals.pop("fork_exec")
        gated_fork_exec.__kwdefaults__ = {"_audit": sys.audit}
        # Both bindings: `subprocess` captured its own at import, and
        # multiprocessing looks the module attribute up at call time.
        _posixsubprocess.fork_exec = gated_fork_exec
        if subprocess is not None and hasattr(subprocess, "_fork_exec"):
            subprocess._fork_exec = gated_fork_exec
        protected.add(id(gated_fork_exec))
        protected.add(id(gated_fork_exec.__code__))
        handlers["omp.spawn_gate.fork_exec"] = on_fork_exec_call
        if py_version >= (3, 14):
            handlers["_posixsubprocess.fork_exec"] = on_fork_exec_event

    hook_globals = {"__builtins__": {}}
    exec(_HOOK_SOURCE, hook_globals)
    hook = hook_globals.pop("hook")
    hook.__defaults__ = (dispatch,)
    for fn in (hook, dispatch, guarded, judge, judge_executable, check_fork_exec, on_fork_exec_call, post, text, json_str, display_argv, refusal, *handlers.values()):
        protected.add(id(fn))
        protected.add(id(fn.__code__))
    sys.addaudithook(hook)
    return bridge_ready
