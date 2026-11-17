//! The smallest manifest the app writes (the Problems view's "Disable this check for the project" in a project
//! without a w3proj.toml): `format` plus a `[checks]` section. `Manifest::load` must accept it. The app's
//! `checkconfig.test.ts` asserts it writes exactly this file.

use std::path::Path;

use w3proj::project::Manifest;

#[test]
fn the_app_written_minimal_manifest_loads() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/manifest-minimal-checks");
    let m = Manifest::load(&dir).expect("minimal manifest loads");
    assert_eq!(m.format, w3proj::project::FORMAT_VERSION);
    assert!(m.map.is_none());
}

#[test]
fn control_a_manifest_without_format_is_refused() {
    // Under target/ (not the OS temp folder), removed again when the test ends, also when an assert fails.
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("w3proj-minimal-control-{}", std::process::id()));
    let _cleanup = Cleanup(dir.clone());
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(w3proj::project::MANIFEST), "[checks]\ndisable = [\"a\"]\n").unwrap();
    assert!(Manifest::load(&dir).is_err());
}
