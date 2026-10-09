//! Converting text positions for the webview.
//!
//! Rust indexes a `&str` by UTF-8 byte, while JavaScript strings and
//! CodeMirror index by UTF-16 code unit. The two drift apart at the first
//! multi-byte character (a curly quote, an em dash, an accent), so any
//! position sent to the frontend for highlighting or cursor placement is
//! converted here first.

/// Byte offset → UTF-16 code-unit offset within `text`. An offset past the
/// end clamps to the end, and one inside a character rounds down to its start.
pub fn byte_to_utf16(text: &str, byte_off: usize) -> usize {
    let mut b = byte_off.min(text.len());
    while b > 0 && !text.is_char_boundary(b) {
        b -= 1;
    }
    text[..b].encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_past_multibyte() {
        // `“` is 3 UTF-8 bytes but 1 UTF-16 unit, so "is" starts at byte 5
        // (3+1+1) but at UTF-16 index 3 (1+1+1).
        assert_eq!(byte_to_utf16("“a is", 5), 3);
        assert_eq!(byte_to_utf16("hello world", 6), 6);
        assert_eq!(byte_to_utf16("ab", 99), 2);
    }
}
