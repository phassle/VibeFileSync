use std::borrow::Cow;

/// Converts runtime error text into the stable failure vocabulary shared by
/// the public run stream and the retained Journal.
pub fn normalize(reason: &str) -> Cow<'_, str> {
    if reason.contains("source changed") {
        Cow::Borrowed("source_changed")
    } else if reason.contains("verify mismatch") {
        Cow::Borrowed("verify_mismatch")
    } else if reason.contains("No space left on device") {
        Cow::Borrowed("destination_full")
    } else {
        Cow::Borrowed(reason)
    }
}
