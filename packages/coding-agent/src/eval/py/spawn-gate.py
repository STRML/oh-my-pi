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
# Everything the hook needs is captured at install time and the bridge client
# speaks HTTP over the C socket type, so monkeypatching `json`, `urllib`,
# `socket` or a prelude global cannot change what is judged.


def install(environ, run_id_getter, timeout=600.0):
    """Install the hook. The bridge endpoint and token are pinned now, before
    any cell runs, so a cell cannot point the gate at a server of its own. The
    bridge session is read per spawn: it only selects which host registration
    judges, and a wrong one is refused."""
    import sys, os, _socket, _thread

    url = environ.get("PI_TOOL_BRIDGE_URL") or ""
    token = environ.get("PI_TOOL_BRIDGE_TOKEN") or ""
    session_of = environ.get
    host, port = "", 0
    if url.startswith("http://"):
        host, _, port_text = url[len("http://"):].rstrip("/").rpartition(":")
        port = int(port_text) if port_text.isdigit() else 0
    bridge_ready = bool(host and port and token)

    socket_type = _socket.socket
    af_inet, sock_stream = _socket.AF_INET, _socket.SOCK_STREAM
    getcwd, fspath, getpid, write, exit_now = os.getcwd, os.fspath, os.getpid, os.write, os._exit
    install_pid = getpid()
    # A forked child's last verdict: (key, allowed).
    last_child_verdict = [None]
    py_version = sys.version_info[:2]
    local = _thread._local()
    json_loads = __import__("json").loads  # Error text only; never decides a verdict.

    # Runner housekeeping: listing child pids to stop an installer's process tree.
    internal = frozenset({("/bin/ps", "-A", "-o", "pid=,ppid="), ("ps", "-A", "-o", "pid=,ppid=")})
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

    def basename(value):
        return value.rsplit("/", 1)[-1]

    def argv_of(program, args):
        """Real argv, with argv[0] replaced when the executed program differs from it."""
        argv = [text(arg) for arg in (args or ())]
        if program is None:
            return argv
        program = text(program)
        if not argv:
            return [program]
        if basename(program) != basename(argv[0]):
            argv[0] = program
        return argv

    class SpawnRefused(PermissionError):
        pass

    def refuse(api, reason):
        message = f"eval subprocess spawn refused ({api}): {reason}"
        if api == "os.exec" and getpid() != install_pid:
            # A forked child whose exec is refused must not fall back into the
            # kernel's own code (pty.spawn, os.spawn* and hand-rolled fork+exec
            # all do on an exec error), so it ends here.
            write(2, (message + "\n").encode("utf-8", "replace"))
            exit_now(126)
        raise SpawnRefused(message)

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
        if argv is not None and tuple(argv) in internal:
            return
        if not bridge_ready:
            refuse(api, "no host bridge in this kernel")
        cwd = text(cwd) if cwd is not None else getcwd()
        # `execvp` in a forked child tries each PATH entry with the same argv;
        # one verdict covers those retries, and the child is gone after exec.
        key = (api, tuple(argv or ()), command, cwd)
        in_child = getpid() != install_pid
        if in_child and last_child_verdict[0] is not None and last_child_verdict[0][0] == key:
            if last_child_verdict[0][1]:
                return
            refuse(api, "denied")
        run = run_id_getter()
        fields = [
            '"session":' + json_str(text(session_of("PI_TOOL_BRIDGE_SESSION") or "")),
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
            refuse(api, f"host bridge unreachable: {exc}")
        head, _, payload = response.partition(b"\r\n\r\n")
        if head.startswith((b"HTTP/1.1 200 ", b"HTTP/1.0 200 ")) and payload.startswith(allowed_prefix):
            if in_child:
                last_child_verdict[0] = (key, True)
            return
        try:
            reason = json_loads(payload).get("error") or "denied"
        except Exception:
            reason = "malformed host verdict"
        if in_child:
            last_child_verdict[0] = (key, False)
        refuse(api, reason)

    def on_popen(args):
        # Python 3.14+ audits the C `fork_exec`; remember Popen's cwd for it.
        local.cwd = args[2]

    def on_fork_exec(args):
        cwd, local.cwd = getattr(local, "cwd", None), None
        candidates, argv = args[0], args[1]
        program = candidates[0] if candidates and len(candidates) > 0 else None
        if program is not None and argv and all(basename(text(c)) == basename(text(argv[0])) for c in candidates):
            program = None
        judge("subprocess", argv=argv_of(program, argv), cwd=cwd)

    def on_system(args):
        judge("os.system", command=text(args[0]))

    def on_exec(args):
        judge("os.exec", argv=argv_of(args[0], args[1]))

    def on_posix_spawn(args):
        judge("os.posix_spawn", argv=argv_of(args[0], args[1]))

    def on_spawn(args):
        judge("os.spawn", argv=argv_of(args[1], args[2]))

    def on_create_process(args):
        judge("_winapi.CreateProcess", command=text(args[1] or args[0]), cwd=args[2])

    def on_ffi(args):
        refuse("ctypes", "native FFI can load and call any libc function, so the eval kernel refuses it")

    def on_import(args):
        if args and args[0] in ("_ctypes", "_cffi_backend"):
            refuse(args[0], "native FFI can load and call any libc function, so the eval kernel refuses it")

    def on_introspect(args):
        # These reach the hook's own frames and closures, which is how a cell
        # would rewrite what the gate judges.
        raise PermissionError("eval kernel: this introspection is disabled by the spawn gate")

    protected = set()

    def on_setattr(args):
        if id(args[0]) in protected:
            raise PermissionError("eval kernel: the spawn gate cannot be modified")

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

    if py_version >= (3, 14):
        handlers["subprocess.Popen"] = on_popen
        handlers["_posixsubprocess.fork_exec"] = on_fork_exec
    else:
        # Before 3.14 the C `fork_exec` raises no audit event, so the gate wraps
        # it. Both bindings are wrapped because `subprocess` captured its own at
        # import. A cell that builds a fresh `_posixsubprocess` module reaches
        # the unwrapped C function; that residual closes on 3.14+.
        try:
            import _posixsubprocess, subprocess
        except ImportError:
            _posixsubprocess = subprocess = None
        if _posixsubprocess is not None:
            original_fork_exec = _posixsubprocess.fork_exec

            def gated_fork_exec(*args, **kwargs):
                cwd = args[4] if len(args) > 4 else kwargs.get("cwd")
                judge("subprocess", argv=argv_of(None, args[0]), cwd=cwd)
                return original_fork_exec(*args, **kwargs)

            protected.add(id(gated_fork_exec))
            protected.add(id(gated_fork_exec.__code__))
            _posixsubprocess.fork_exec = gated_fork_exec
            if subprocess is not None and hasattr(subprocess, "_fork_exec"):
                subprocess._fork_exec = gated_fork_exec

    def hook(event, args):
        handler = handlers.get(event)
        if handler is not None:
            handler(args)

    for fn in (hook, judge, post, text, json_str, argv_of, refuse, *handlers.values()):
        protected.add(id(fn))
        protected.add(id(fn.__code__))
    sys.addaudithook(hook)
    return bridge_ready
