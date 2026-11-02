# OMP eval spawn gate. The prelude executes this source in its own namespace
# (not the user's), then calls `install`. Every subprocess the kernel would
# start is first sent to the host with its real argv and cwd, and runs only
# after the host's bash gate approves it.
#
# Interception is a CPython audit hook (PEP 578). Hooks cannot be removed, and
# the events are raised by the C functions themselves, so a re-imported `os`,
# `posix` or `_posixsubprocess`, a `getattr` with a computed name, or
# `importlib.reload` all reach the same hook. Native FFI is refused outright:
# a `ctypes`/`cffi` call has no argv to judge.
#
# Everything the gate needs is captured at install time, and the bridge client
# speaks HTTP over the C socket type with hand-built JSON, so monkeypatching
# `json`, `urllib`, `socket` or a prelude global cannot change what is judged.
# A refusal leaves nothing behind for the cell: handlers return a message
# instead of raising, and the hook raises a fresh error from a frame whose
# locals hold only the event, so a caught refusal's traceback reaches no gate
# state.

# The hook looks up no global or builtin name: everything it touches arrives
# as a default argument, so clearing its frame's globals or builtins from a
# caught traceback changes nothing.
_HOOK_SOURCE = """
def hook(event, args, _dispatch=None, _refused=None, _interrupt=None):
    message = _dispatch(event, args)
    del _dispatch
    if message is None:
        return
    if message == "\\x00interrupt":
        raise _interrupt
    raise _refused(message)
"""

_INTERRUPT = "\x00interrupt"
_NATIVE_CODE = "native FFI can load and call any libc function, so the eval kernel refuses it"


def install(environ, run_id_getter, timeout=600.0):
    """Install the hook. The bridge endpoint, token and PATH are pinned now,
    before any cell runs, so a cell cannot point the gate at a server of its
    own or hide a binary behind a PATH it set. The bridge session is read per
    spawn: it only selects which host registration judges, and a wrong one is
    refused."""
    import sys, os, _socket

    url = environ.get("PI_TOOL_BRIDGE_URL") or ""
    token = environ.get("PI_TOOL_BRIDGE_TOKEN") or ""
    env_of = environ.get
    startup_path = environ.get("PATH") or ""
    host, port = "", 0
    if url.startswith("http://"):
        host, _, port_text = url[len("http://"):].rstrip("/").rpartition(":")
        port = int(port_text) if port_text.isdigit() else 0
    bridge_ready = bool(host and port and token)

    socket_type = _socket.socket
    af_inet, sock_stream = _socket.AF_INET, _socket.SOCK_STREAM
    getcwd, fspath, getpid, write, exit_now = os.getcwd, os.fspath, os.getpid, os.write, os._exit
    stat, access, x_ok = os.stat, os.access, os.X_OK
    install_pid = getpid()
    # A forked child's last verdict: (key, message or None).
    last_child_verdict = [None]
    popen_cwd = {}  # thread id -> cwd of the Popen whose fork_exec comes next
    get_ident = __import__("_thread").get_ident
    py_version = sys.version_info[:2]
    json_loads = __import__("json").loads  # Error text only; never decides a verdict.

    # Runner housekeeping: listing child pids to stop an installer's process tree.
    internal = ("/bin/ps", ("/bin/ps", "-A", "-o", "pid=,ppid="))
    refused_prefix = "eval subprocess spawn refused"
    allowed_prefix = b'{"ok":true,"value":{"allowed":true'
    escapes = {i: "\\u%04x" % i for i in range(0x20)}
    escapes.update({ord('"'): '\\"', ord("\\"): "\\\\", 0x2028: "\\u2028", 0x2029: "\\u2029"})

    def text(value):
        value = fspath(value) if not isinstance(value, (str, bytes, bytearray)) else value
        if isinstance(value, (bytes, bytearray)):
            return bytes(value).decode("utf-8", "surrogateescape")
        return str(value)

    def json_str(value):
        return '"' + value.encode("utf-8", "surrogatepass").decode("utf-8", "replace").translate(escapes) + '"'

    def is_executable(candidate):
        try:
            return (stat(candidate).st_mode & 0o170000) == 0o100000 and access(candidate, x_ok)
        except (OSError, ValueError):
            return False

    def resolve(name, search_path):
        """The file an exec-p call would run for `name` under `search_path`."""
        if "/" in name:
            return name
        for directory in search_path.split(":"):
            candidate = (directory or ".") + "/" + name
            if is_executable(candidate):
                return candidate
        return None

    def display_argv(executed, args):
        """The argv to judge. argv[0] stays as written only when the startup
        PATH resolves it to the file that actually runs; otherwise it becomes
        that file's path, so a PATH hijack or an `executable=` override shows."""
        argv = [text(arg) for arg in (args or ())]
        if executed is None:
            return argv
        executed = text(executed)
        if not argv:
            return [executed]
        if argv[0] != executed and ("/" in argv[0] or resolve(argv[0], startup_path) != executed):
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
        return message

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

    def judge(api, argv=None, command=None, cwd=None):
        """None when the host allows the spawn, else the refusal message."""
        if not bridge_ready:
            return refusal(api, "no host bridge in this kernel")
        cwd = text(cwd) if cwd is not None else getcwd()
        # `execvp` in a forked child tries each PATH entry; one verdict covers
        # those retries, and the child is gone after exec.
        key = (api, tuple(argv or ()), command, cwd)
        in_child = getpid() != install_pid
        if in_child and last_child_verdict[0] is not None and last_child_verdict[0][0] == key:
            reason = last_child_verdict[0][1]
            return None if reason is None else refusal(api, reason)
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
        body = ("{" + ",".join(fields) + ',"args":{' + ",".join(request) + "}}").encode("utf-8")
        try:
            response = post(body)
        except OSError as exc:
            return refusal(api, f"host bridge unreachable: {exc}")
        head, _, payload = response.partition(b"\r\n\r\n")
        reason = None
        if not (head.startswith((b"HTTP/1.1 200 ", b"HTTP/1.0 200 ")) and payload.startswith(allowed_prefix)):
            try:
                reason = json_loads(payload).get("error") or "denied"
            except Exception:
                reason = "malformed host verdict"
        if in_child:
            last_child_verdict[0] = (key, reason)
        return None if reason is None else refusal(api, reason)

    def judge_exec(api, executed, args, cwd=None):
        executed_text = text(executed)
        if not is_executable(executed_text):
            # Nothing can run: the call fails with ENOENT/EACCES on its own.
            # `execvp` probes every PATH entry this way before the real one.
            return None
        argv = display_argv(executed_text, args)
        if (executed_text, tuple(argv)) == internal:
            return None
        return judge(api, argv=argv, cwd=cwd)

    def on_popen(args):
        # Python 3.14+ audits the C `fork_exec`; remember Popen's cwd for it.
        popen_cwd[get_ident()] = args[2]

    def on_fork_exec(args):
        cwd = popen_cwd.pop(get_ident(), None)
        candidates, argv = args[0], args[1]
        executed = None
        for candidate in candidates or ():
            if is_executable(text(candidate)):
                executed = candidate
                break
        if executed is None:
            return None
        return judge_exec("subprocess", executed, argv, cwd)

    def on_system(args):
        return judge("os.system", command=text(args[0]))

    def on_exec(args):
        return judge_exec("os.exec", args[0], args[1])

    def on_posix_spawn(args):
        path = text(args[0])
        # posix_spawnp searches the PATH the process holds right now.
        executed = path if "/" in path else resolve(path, text(env_of("PATH") or ""))
        if executed is None:
            return None
        return judge_exec("os.posix_spawn", executed, args[1])

    def on_spawn(args):
        return judge("os.spawn", argv=display_argv(args[1], args[2]))

    def on_create_process(args):
        return judge("_winapi.CreateProcess", command=text(args[1] or args[0]), cwd=args[2])

    def on_ffi(args):
        return f"eval subprocess spawn refused (ctypes): {_NATIVE_CODE}"

    def on_import(args):
        if args and args[0] in ("_ctypes", "_cffi_backend"):
            return f"eval subprocess spawn refused ({args[0]}): {_NATIVE_CODE}"
        return None

    def on_introspect(args):
        # These reach live gate frames, which is how a cell would rewrite what
        # the gate judges.
        return "eval kernel: this introspection is disabled by the spawn gate"

    protected = set()

    def on_setattr(args):
        if id(args[0]) in protected:
            return "eval kernel: the spawn gate cannot be modified"
        return None

    handlers = {
        "os.system": on_system,
        "os.exec": on_exec,
        "os.posix_spawn": on_posix_spawn,
        "os.spawn": on_spawn,
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

    def dispatch(event, args):
        handler = handlers.get(event)
        if handler is None:
            return None
        try:
            return handler(args)
        except KeyboardInterrupt:
            return _INTERRUPT
        except BaseException as exc:  # Fail closed, and let no gate frame escape.
            message = f"eval subprocess spawn refused: gate error {type(exc).__name__}: {exc}"
            del exc
            return message

    if py_version >= (3, 14):
        handlers["subprocess.Popen"] = on_popen
        handlers["_posixsubprocess.fork_exec"] = on_fork_exec
    else:
        # Before 3.14 the C `fork_exec` raises no audit event, so the gate wraps
        # it. Both bindings are wrapped because `subprocess` captured its own at
        # import. The original stays reachable through the wrapper's closure
        # and a freshly built `_posixsubprocess` module; both close on 3.14+.
        try:
            import _posixsubprocess, subprocess
        except ImportError:
            _posixsubprocess = subprocess = None
        if _posixsubprocess is not None:
            original_fork_exec = _posixsubprocess.fork_exec

            def gated_fork_exec(*args, **kwargs):
                cwd = args[4] if len(args) > 4 else kwargs.get("cwd")
                message = dispatch("_posixsubprocess.fork_exec", (args[1], args[0], None, cwd))
                if message is not None:
                    raise PermissionError(message)
                return original_fork_exec(*args, **kwargs)

            def on_wrapped_fork_exec(args):
                popen_cwd[get_ident()] = args[3]
                return on_fork_exec(args)

            handlers["_posixsubprocess.fork_exec"] = on_wrapped_fork_exec
            protected.add(id(gated_fork_exec))
            protected.add(id(gated_fork_exec.__code__))
            _posixsubprocess.fork_exec = gated_fork_exec
            if subprocess is not None and hasattr(subprocess, "_fork_exec"):
                subprocess._fork_exec = gated_fork_exec

    hook_globals = {"__builtins__": {}}
    exec(_HOOK_SOURCE, hook_globals)
    hook = hook_globals.pop("hook")
    hook.__defaults__ = (dispatch, PermissionError, KeyboardInterrupt)
    for fn in (hook, dispatch, judge, judge_exec, post, text, json_str, display_argv, refusal, *handlers.values()):
        protected.add(id(fn))
        protected.add(id(fn.__code__))
    sys.addaudithook(hook)
    return bridge_ready
