use super::*;

async fn inspection_run(
	shell: &Shell,
	command: impl Into<String>,
	cwd: &Path,
	expect: Option<RunExpect>,
) -> (ShellRunResult, String) {
	let (send, recv) = flume::unbounded();
	let result = shell
		.run(
			ShellRunOptions {
				command: command.into(),
				cwd: Some(cwd.to_string_lossy().into_owned()),
				expect,
				..Default::default()
			},
			Some(send),
			CancelToken::default(),
		)
		.await
		.unwrap();
	(result, recv.try_iter().collect())
}

/// Inspection must select the executable the engine can run for this user.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn inspection_path_skips_files_executable_only_by_other_users() {
	use std::os::unix::fs::PermissionsExt;
	let root = tempfile::tempdir().unwrap();
	for (dir, mode, output) in [("a", 0o001, "EVIL"), ("b", 0o755, "GOOD")] {
		let dir = root.path().join(dir);
		fs::create_dir(&dir).unwrap();
		let file = dir.join("zzfoo");
		fs::write(&file, format!("#!/bin/sh\nprintf '{output}\\n'\n")).unwrap();
		fs::set_permissions(&file, fs::Permissions::from_mode(mode)).unwrap();
	}
	let shell = Shell::new(None);
	let (result, _) =
		inspection_run(&shell, "PATH=$PWD/a:$PWD/b:/usr/bin:/bin", root.path(), None).await;
	assert_eq!(result.exit_code, Some(0));
	let report = shell.inspect(vec!["zzfoo".into()]).await.unwrap();
	assert_eq!(report.resolution, vec![(
		"zzfoo".into(),
		Resolution::File(path_bytes(&root.path().join("b/zzfoo")))
	)]);
	let (result, output) = inspection_run(&shell, "zzfoo", root.path(), None).await;
	assert_eq!((result.exit_code, output.trim()), (Some(0), "GOOD"));
}

/// Exported functions affect child interpreters even when scalar exports match.
#[tokio::test(flavor = "multi_thread")]
async fn inspection_reports_exported_functions_as_hooks() {
	let root = tempfile::tempdir().unwrap();
	let shell = Shell::new(None);
	inspection_run(&shell, "zzt(){ echo EXPORTED_FN_RAN; }; export -f zzt", root.path(), None).await;
	assert!(
		shell
			.inspect(Vec::new())
			.await
			.unwrap()
			.hooks
			.contains(&"func-export:zzt".into())
	);
	inspection_run(&shell, "export -n -f zzt", root.path(), None).await;
	assert!(
		!shell
			.inspect(Vec::new())
			.await
			.unwrap()
			.hooks
			.contains(&"func-export:zzt".into())
	);
}

/// The first snapshot's options are the baseline, including after core loss.
#[tokio::test(flavor = "multi_thread")]
async fn inspection_pins_options_after_snapshot_and_preserves_pin_on_rebuild() {
	let root = tempfile::tempdir().unwrap();
	let snapshot = root.path().join("snapshot.sh");
	fs::write(&snapshot, "shopt -s expand_aliases\n").unwrap();
	let shell = Shell::new(Some(ShellOptions {
		snapshot_path: Some(snapshot.to_string_lossy().into_owned()),
		..Default::default()
	}));
	inspection_run(&shell, ":", root.path(), None).await;
	assert_eq!(shell.inspect(Vec::new()).await.unwrap().options_changed, Vec::<String>::new());
	inspection_run(&shell, "shopt -u expand_aliases", root.path(), None).await;
	assert_eq!(shell.inspect(Vec::new()).await.unwrap().options_changed, vec!["expand_aliases"]);
	*shell.session.lock().await = None;
	fs::write(&snapshot, "shopt -u expand_aliases\n").unwrap();
	inspection_run(&shell, ":", root.path(), None).await;
	assert_eq!(shell.inspect(Vec::new()).await.unwrap().options_changed, vec!["expand_aliases"]);
}

/// Reviewed commands cannot race an external file swapper or an engine job.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn reviewed_runs_refuse_live_background_jobs_before_file_checks_or_execution() {
	let root = tempfile::tempdir().unwrap();
	fs::write(root.path().join("good.sh"), "echo GOOD\n").unwrap();
	fs::write(root.path().join("evil.sh"), "echo EVIL\n").unwrap();
	for background in [
		"nohup /bin/sh -c 'while :; do /bin/cp evil.sh s.sh.t; /bin/mv s.sh.t s.sh; /bin/cp good.sh \
		 s.sh.t; /bin/mv s.sh.t s.sh; done' >/dev/null 2>&1 &",
		"while :; do :; done &",
	] {
		let shell = Shell::new(None);
		fs::write(root.path().join("s.sh"), "echo GOOD\n").unwrap();
		let (started, _) = inspection_run(&shell, background, root.path(), None).await;
		assert_eq!(started.exit_code, Some(0));
		// The gate reads the live job as a hook and skips the review up front.
		assert!(
			shell
				.inspect(Vec::new())
				.await
				.unwrap()
				.hooks
				.contains(&"jobs:live".to_string()),
			"{background}"
		);
		let mut refusals = Vec::new();
		let mut outputs = Vec::new();
		for _ in 0..60 {
			let state = shell.inspect(Vec::new()).await.unwrap().fingerprint;
			let (result, output) = inspection_run(
				&shell,
				"/bin/sh ./s.sh; printf ran > marker",
				root.path(),
				Some(RunExpect {
					state,
					files: vec![(root.path().join("s.sh"), Sha256::digest(b"echo GOOD\n").into())],
				}),
			)
			.await;
			refusals.push(result.refused);
			outputs.push(output);
		}
		// Always stop the probe's swapper, including on the pre-fix run.
		inspection_run(&shell, "kill %1; wait; :", root.path(), None).await;
		assert!(
			refusals
				.iter()
				.all(|reason| reason.as_deref() == Some("background jobs are running")),
			"{background}: {refusals:?}"
		);
		assert!(outputs.iter().all(String::is_empty), "{outputs:?}");
		assert!(!root.path().join("marker").exists());
		// A completed job's retained status must not block future reviewed runs.
		let report = shell.inspect(Vec::new()).await.unwrap();
		assert!(!report.hooks.contains(&"jobs:live".to_string()), "{background}: {:?}", report.hooks);
		let state = report.fingerprint;
		let (result, _) =
			inspection_run(&shell, ":", root.path(), Some(RunExpect { state, files: Vec::new() }))
				.await;
		assert_eq!((result.refused, result.exit_code), (None, Some(0)));
	}
}

/// Removing a job-table entry must not permit a still-running child to race a
/// reviewed command.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn reviewed_runs_refuse_disowned_background_work() {
	let root = tempfile::tempdir().unwrap();
	let mut refusals = Vec::new();
	for background in ["/bin/sleep 30 & bg=$!; disown", "while :; do :; done & bg=$!; disown"] {
		let shell = Shell::new(None);
		let (started, _) = inspection_run(&shell, background, root.path(), None).await;
		assert_eq!(started.exit_code, Some(0));
		let state = shell.inspect(Vec::new()).await.unwrap().fingerprint;
		let (result, output) = inspection_run(
			&shell,
			"echo forbidden; printf ran > marker",
			root.path(),
			Some(RunExpect { state, files: Vec::new() }),
		)
		.await;
		inspection_run(&shell, "kill \"$bg\"; :", root.path(), None).await;
		refusals.push((result.refused, output));
	}
	assert!(
		refusals
			.iter()
			.all(|(reason, output)| reason.as_deref() == Some("background jobs are running")
				&& output.is_empty()),
		"{refusals:?}"
	);
	assert!(!root.path().join("marker").exists());
}

/// Persistent descriptors change execution even though no store record changes.
#[tokio::test(flavor = "multi_thread")]
async fn inspection_reports_persistent_fds_and_invalidates_older_tokens() {
	let root = tempfile::tempdir().unwrap();
	let shell = Shell::new(None);
	inspection_run(&shell, ":", root.path(), None).await;
	let before = shell.inspect(Vec::new()).await.unwrap().fingerprint;
	let (opened, _) = inspection_run(&shell, "exec 7>x", root.path(), None).await;
	assert_eq!(opened.exit_code, Some(0));
	inspection_run(&shell, ":", root.path(), None).await;
	let report = shell.inspect(Vec::new()).await.unwrap();
	assert!(report.hooks.contains(&"fd:7".into()));
	assert_ne!(report.fingerprint, before);
	let (result, _) = inspection_run(
		&shell,
		"printf forbidden > marker",
		root.path(),
		Some(RunExpect { state: before, files: Vec::new() }),
	)
	.await;
	assert_eq!(result.refused.as_deref(), Some("shell state changed"));
	assert!(!root.path().join("marker").exists());
	inspection_run(&shell, "echo viafd >&7; exec 7>&-", root.path(), None).await;
	assert_eq!(fs::read_to_string(root.path().join("x")).unwrap(), "viafd\n");
	let closed = shell.inspect(Vec::new()).await.unwrap();
	assert!(!closed.hooks.contains(&"fd:7".into()));
	assert_ne!(closed.fingerprint, report.fingerprint);
}

/// Missing/unreadable setup stays optional, but existence changes stay visible.
#[tokio::test(flavor = "multi_thread")]
async fn inspection_tolerates_absent_snapshots_and_detects_existence_changes() {
	let root = tempfile::tempdir().unwrap();
	for initially_present in [false, true] {
		let snapshot = root.path().join(if initially_present {
			"present.sh"
		} else {
			"absent.sh"
		});
		if initially_present {
			fs::write(&snapshot, "export SNAPSHOT_LOADED=yes\n").unwrap();
		}
		let shell = Shell::new(Some(ShellOptions {
			snapshot_path: Some(snapshot.to_string_lossy().into_owned()),
			..Default::default()
		}));
		let (first, _) = inspection_run(&shell, "echo hi", root.path(), None).await;
		assert_eq!(first.exit_code, Some(0));
		assert!(!shell.inspect(Vec::new()).await.unwrap().snapshot_changed);
		*shell.session.lock().await = None;
		if initially_present {
			fs::remove_file(&snapshot).unwrap();
		} else {
			fs::write(&snapshot, "export SNAPSHOT_LOADED=yes\n").unwrap();
		}
		let (rebuilt, _) = inspection_run(&shell, ":", root.path(), None).await;
		assert_eq!(rebuilt.exit_code, Some(0));
		assert!(shell.inspect(Vec::new()).await.unwrap().snapshot_changed);
		*shell.session.lock().await = None;
		// A directory is an unreadable snapshot regardless of the test user's
		// uid.
		if snapshot.is_file() {
			fs::remove_file(&snapshot).unwrap();
		}
		fs::create_dir(&snapshot).unwrap();
		let (unreadable, _) = inspection_run(&shell, ":", root.path(), None).await;
		assert_eq!(unreadable.exit_code, Some(0));
		assert!(shell.inspect(Vec::new()).await.unwrap().snapshot_changed);
	}
}

/// Inspection must never execute setup code in a previously unused shell.
#[tokio::test(flavor = "multi_thread")]
async fn inspect_without_core_does_not_source_snapshot() {
	let root = tempfile::tempdir().unwrap();
	let marker = root.path().join("sourced");
	let snapshot = root.path().join("snapshot.sh");
	fs::write(&snapshot, format!("printf sourced > '{}'", marker.display())).unwrap();
	let shell = Shell::new(Some(ShellOptions {
		snapshot_path: Some(snapshot.to_string_lossy().into_owned()),
		..Default::default()
	}));
	assert!(shell.inspect(Vec::new()).await.is_none());
	assert!(!marker.exists(), "inspection executed the snapshot");
}

/// A review token must not cause the snapshot to execute while creating a core.
#[tokio::test(flavor = "multi_thread")]
async fn token_without_core_refuses_before_snapshot_or_command() {
	let root = tempfile::tempdir().unwrap();
	let marker = root.path().join("sourced");
	let command_marker = root.path().join("command");
	let snapshot = root.path().join("snapshot.sh");
	fs::write(&snapshot, format!("printf sourced > '{}'", marker.display())).unwrap();
	let shell = Shell::new(Some(ShellOptions {
		snapshot_path: Some(snapshot.to_string_lossy().into_owned()),
		..Default::default()
	}));
	let result = shell
		.run(
			ShellRunOptions {
				command: format!("printf ran > '{}'", command_marker.display()),
				expect: Some(RunExpect { state: [0; 32], files: Vec::new() }),
				..Default::default()
			},
			None,
			CancelToken::default(),
		)
		.await
		.unwrap();
	assert_eq!(result.refused.as_deref(), Some("shell session unavailable"));
	assert!(!marker.exists());
	assert!(!command_marker.exists());
}

/// Export and snapshot baselines remain tied to the first build after core
/// loss.
#[tokio::test(flavor = "multi_thread")]
async fn edited_snapshot_rebuild_preserves_original_review_baselines() {
	let root = tempfile::tempdir().unwrap();
	let snapshot = root.path().join("snapshot.sh");
	fs::write(&snapshot, "export REVIEW_BASELINE=original").unwrap();
	let shell = Shell::new(Some(ShellOptions {
		snapshot_path: Some(snapshot.to_string_lossy().into_owned()),
		..Default::default()
	}));
	shell
		.run(
			ShellRunOptions { command: ":".into(), ..Default::default() },
			None,
			CancelToken::default(),
		)
		.await
		.unwrap();
	let first = shell.inspect(Vec::new()).await.unwrap();
	assert!(!first.snapshot_changed);
	assert!(!first.exports_changed.contains(&"REVIEW_BASELINE".into()));
	// A cancelled/broken core is discarded by run_shell_session in production.
	*shell.session.lock().await = None;
	fs::write(&snapshot, "export REVIEW_BASELINE=edited").unwrap();
	shell
		.run(
			ShellRunOptions { command: ":".into(), ..Default::default() },
			None,
			CancelToken::default(),
		)
		.await
		.unwrap();
	let rebuilt = shell.inspect(Vec::new()).await.unwrap();
	assert!(rebuilt.snapshot_changed);
	assert!(rebuilt.exports_changed.contains(&"REVIEW_BASELINE".into()));
	*shell.session.lock().await = None;
	fs::write(&snapshot, "export REVIEW_BASELINE=original").unwrap();
	shell
		.run(
			ShellRunOptions { command: ":".into(), ..Default::default() },
			None,
			CancelToken::default(),
		)
		.await
		.unwrap();
	let restored = shell.inspect(Vec::new()).await.unwrap();
	assert!(restored.snapshot_changed, "snapshot change must be sticky");
	assert!(!restored.exports_changed.contains(&"REVIEW_BASELINE".into()));
}

/// Busy review calls must return promptly rather than observing later state.
#[tokio::test(flavor = "multi_thread")]
async fn busy_shell_inspect_and_token_run_refuse_without_waiting() {
	let shell = Shell::new(None);
	shell
		.run(
			ShellRunOptions { command: ":".into(), ..Default::default() },
			None,
			CancelToken::default(),
		)
		.await
		.unwrap();
	let state = shell.inspect(Vec::new()).await.unwrap().fingerprint;
	let _guard = shell.session.lock().await;
	assert!(
		time::timeout(Duration::from_millis(100), shell.inspect(Vec::new()))
			.await
			.unwrap()
			.is_none()
	);
	let result = time::timeout(
		Duration::from_millis(100),
		shell.run(
			ShellRunOptions {
				command: ":".into(),
				expect: Some(RunExpect { state, files: Vec::new() }),
				..Default::default()
			},
			None,
			CancelToken::default(),
		),
	)
	.await
	.unwrap()
	.unwrap();
	assert_eq!(result.refused.as_deref(), Some("shell session busy"));
}

/// A reviewed chain is one submission, so its first segment cannot stale its
/// token.
#[tokio::test(flavor = "multi_thread")]
async fn reviewed_chain_with_minimizer_executes_all_segments_once() {
	let root = tempfile::tempdir().unwrap();
	let marker = root.path().join("marker");
	let shell = Shell::new(Some(ShellOptions {
		minimizer: Some(minimizer::MinimizerOptions { enabled: Some(true), ..Default::default() }),
		..Default::default()
	}));
	shell
		.run(
			ShellRunOptions { command: ":".into(), ..Default::default() },
			None,
			CancelToken::default(),
		)
		.await
		.unwrap();
	let state = shell.inspect(Vec::new()).await.unwrap().fingerprint;
	let command = format!("echo first; printf reviewed > '{}'", marker.display());
	let result = shell
		.run(
			ShellRunOptions {
				command,
				expect: Some(RunExpect { state, files: Vec::new() }),
				..Default::default()
			},
			None,
			CancelToken::default(),
		)
		.await
		.unwrap();
	assert_eq!(result.refused, None);
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(fs::read_to_string(marker).unwrap(), "reviewed");
}
