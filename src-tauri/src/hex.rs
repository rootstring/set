use std::fmt::Write as _;

pub fn encode(bytes: &[u8]) -> String {
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut out, b| {
            let _ = write!(out, "{b:02x}");
            out
        })
}

/// Exactly `N` bytes, or `None`: a short, long or non-hex string is never padded or cut.
pub fn decode<const N: usize>(text: &str) -> Option<[u8; N]> {
    // `from_str_radix` would let a sign through.
    if text.len() != N * 2 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut bytes = [0u8; N];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_round_trip_and_anything_malformed_is_refused() {
        assert_eq!(encode(&[0x00, 0xab, 0xff]), "00abff");
        assert_eq!(decode::<3>("00abff"), Some([0x00, 0xab, 0xff]));
        assert_eq!(decode::<3>("00ab"), None, "too short");
        assert_eq!(decode::<3>("00abff00"), None, "too long");
        assert_eq!(decode::<3>("00abfg"), None, "not hex");
        assert_eq!(decode::<3>("00abé"), None, "not ASCII");
        assert_eq!(decode::<1>("+f"), None, "signed");
    }
}
