import pythonPrelude from "./prelude.py" with { type: "text" };
import spawnGateSource from "./spawn-gate.py" with { type: "text" };

/**
 * Installs the spawn gate after the helpers. The gate source runs in a namespace
 * of its own with a private copy of the builtins, so rebinding a name in the
 * user namespace or in `builtins` cannot change what the gate does.
 * `JSON.stringify` output is a valid Python string literal.
 */
const SPAWN_GATE_INSTALLER = `
if "__omp_spawn_gate__" not in globals():
    def __omp_install_spawn_gate(source):
        import builtins, os
        scope = {"__builtins__": dict(vars(builtins)), "__name__": "omp_spawn_gate"}
        exec(compile(source, "<omp-spawn-gate>", "exec"), scope)
        user_ns = globals()
        current = user_ns.get("__omp_current_run_id__")

        # Threads a cell starts do not inherit the runner's run context; they
        # are judged under the run that is executing now.
        def run_id():
            rid = current() if callable(current) else None
            return rid if rid is not None else user_ns.get("__omp_run_id__")

        functions = (run_id, current) if callable(current) else (run_id,)
        return scope["install"](os.environ, run_id, run_id_functions=functions)
    __omp_spawn_gate__ = __omp_install_spawn_gate(${JSON.stringify(spawnGateSource)})
    del __omp_install_spawn_gate
`;

export const PYTHON_PRELUDE = `${pythonPrelude}\n${SPAWN_GATE_INSTALLER}`;
