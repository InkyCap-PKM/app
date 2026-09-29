//! Handing freed memory back to the operating system.

/// Ask the memory allocator to return free heap memory to the operating
/// system. Call after a burst of short-lived allocations, such as an index
/// build: glibc otherwise keeps freed memory for reuse, so the app goes on
/// holding the burst's peak. Other platforms' allocators return memory on
/// their own, so this does nothing there.
pub fn return_free_memory() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    // SAFETY: malloc_trim only releases free pages and has no preconditions.
    unsafe {
        libc::malloc_trim(0);
    }
}
