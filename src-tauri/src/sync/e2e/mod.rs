//! Real devices on loopback, each with its own folder, state and iroh endpoint.
//!   cd src-tauri && cargo test --no-default-features --lib sync::e2e
//!   SET_SYNC_FUZZ_SEEDS=500 \
//!     cargo test --release --no-default-features --lib sync::e2e::fuzz -- --ignored

mod fuzz;
mod harness;
mod scenarios;
