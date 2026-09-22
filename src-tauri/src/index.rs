use std::collections::{HashMap, HashSet};
use std::sync::RwLock;

use serde::Serialize;
use tauri::State;

const SNIPPET_CHARS: usize = 160;

const SNIPPET_LEAD: usize = 32;

pub const MIN_QUERY_CHARS: usize = 2;

/// A read lock per search: searches run side by side, and a save waits only for the ones under way.
#[derive(Default)]
pub struct SearchIndex(RwLock<HashMap<String, String>>);

impl SearchIndex {
    pub fn replace_all(&self, docs: HashMap<String, String>) {
        if let Ok(mut map) = self.0.write() {
            *map = docs;
        }
    }

    pub fn upsert(&self, id: String, body: String) {
        if let Ok(mut map) = self.0.write() {
            map.insert(id, body);
        }
    }
}

#[derive(Serialize)]
pub struct Segment {
    pub text: String,
    pub hit: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentHit {
    pub id: String,
    pub score: f64,

    pub snippet: Vec<Segment>,

    pub total: usize,
}

/// `only` narrows the pages searched before `limit` is applied, so hits outside the switcher's
/// scope, or on trashed pages, can't crowd out the ones it shows. `async` keeps a long scan off the
/// main thread.
#[tauri::command(async)]
pub fn search_notes(
    index: State<'_, SearchIndex>,
    query: String,
    limit: usize,
    only: Option<HashSet<String>>,
) -> Vec<ContentHit> {
    let Ok(map) = index.0.read() else {
        return Vec::new();
    };
    search_within(&map, &query, limit, only.as_ref())
}

pub fn search_within(
    map: &HashMap<String, String>,
    query: &str,
    limit: usize,
    only: Option<&HashSet<String>>,
) -> Vec<ContentHit> {
    match only {
        Some(ids) => run_search(
            ids.iter().filter_map(|id| map.get_key_value(id)),
            query,
            limit,
        ),
        None => run_search(map, query, limit),
    }
}

/// Not filtered against trashed or deleted pages; the frontend owns the live page list.
#[tauri::command(async)]
pub fn page_backlinks(index: State<'_, SearchIndex>, title: String) -> Vec<String> {
    let Ok(map) = index.0.read() else {
        return Vec::new();
    };
    run_backlinks(&map, &title)
}

pub fn run_backlinks(map: &HashMap<String, String>, title: &str) -> Vec<String> {
    let wanted = title.trim().to_lowercase();
    if wanted.is_empty() {
        return Vec::new();
    }

    let mut ids: Vec<String> = map
        .iter()
        .filter(|(_, body)| body.contains("[["))
        .filter(|(_, body)| {
            wiki_link_titles(body)
                .iter()
                .any(|found| found.to_lowercase() == wanted)
        })
        .map(|(id, _)| id.clone())
        .collect();
    ids.sort();
    ids
}

/// Twin of `wikiLinkTitles` in src/lib/search/wiki-links.ts; the tests below pin both to the same
/// cases.
pub fn wiki_link_titles(body: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut fence: Option<&str> = None;

    for line in body.split('\n') {
        let marker = fence_marker(line);
        if let Some(open) = fence {
            // A fence closes on its own character, and on at least as long a run.
            if let Some(mark) = marker {
                if mark.as_bytes()[0] == open.as_bytes()[0] && mark.len() >= open.len() {
                    fence = None;
                }
            }
            continue;
        }
        if marker.is_some() {
            fence = marker;
            continue;
        }
        scan_line(line, &mut found);
    }
    found
}

/// The ``` or ~~~ run opening or closing a fence, with up to three spaces in front.
fn fence_marker(line: &str) -> Option<&str> {
    let bytes = line.as_bytes();
    let mut at = 0;
    while at < bytes.len() && bytes[at] == b' ' {
        at += 1;
    }
    if at > 3 {
        return None;
    }
    let ch = *bytes.get(at)?;
    if ch != b'`' && ch != b'~' {
        return None;
    }
    let mut end = at;
    while end < bytes.len() && bytes[end] == ch {
        end += 1;
    }
    (end - at >= 3).then(|| &line[at..end])
}

fn scan_line(line: &str, found: &mut Vec<String>) {
    let bytes = line.as_bytes();
    let mut at = 0;

    while at < bytes.len() {
        if bytes[at] == b'`' {
            let mut end = at;
            while end < bytes.len() && bytes[end] == b'`' {
                end += 1;
            }
            let run = &line[at..end];
            // Unclosed backticks are literal text, so only the run itself is skipped.
            at = match line[end..].find(run) {
                Some(offset) => end + offset + run.len(),
                None => end,
            };
            continue;
        }

        if bytes[at] != b'[' || bytes.get(at + 1) != Some(&b'[') {
            at += 1;
            continue;
        }

        let Some(offset) = line[at + 2..].find("]]") else {
            break;
        };
        let end = at + 2 + offset;
        let inner = &line[at + 2..end];
        if inner.contains('[') || inner.contains(']') {
            at += 1; // not a link; markdown-it would try again one character along
            continue;
        }

        let title = link_title(inner);
        if !title.is_empty() {
            found.push(title);
        }
        at = end + 2;
    }
}

/// `Page|shown as` and `Page#Heading` both name the page `Page`.
fn link_title(inner: &str) -> String {
    inner
        .split('|')
        .next()
        .unwrap_or("")
        .split('#')
        .next()
        .unwrap_or("")
        .trim()
        .to_owned()
}

pub fn run_search<'a>(
    docs: impl IntoIterator<Item = (&'a String, &'a String)>,
    query: &str,
    limit: usize,
) -> Vec<ContentHit> {
    let phrase = query.trim().to_lowercase();
    if phrase.chars().count() < MIN_QUERY_CHARS {
        return Vec::new();
    }
    let terms: Vec<String> = phrase.split_whitespace().map(str::to_owned).collect();
    if terms.is_empty() {
        return Vec::new();
    }

    let mut hits: Vec<ContentHit> = docs
        .into_iter()
        .filter_map(|(id, body)| score_page(id, body, &phrase, &terms))
        .collect();

    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.id.cmp(&b.id))
    });
    hits.truncate(limit);
    hits
}

fn score_page(id: &str, body: &str, phrase: &str, terms: &[String]) -> Option<ContentHit> {
    for term in terms {
        find_ci(body, term, 0)?;
    }

    let best = best_line(body, terms)?;
    let line = &body[best.start..best.end];

    let phrase_bonus = if terms.len() > 1 && find_ci(body, phrase, 0).is_some() {
        60.0
    } else {
        0.0
    };

    let density = 20.0 * best.terms as f64;

    let repetition = (best.total as f64).min(10.0);

    let position = 5.0 * (1.0 - best.start as f64 / body.len().max(1) as f64);

    Some(ContentHit {
        id: id.to_owned(),
        score: phrase_bonus + density + repetition + position,
        snippet: snippet(line, &best.ranges),
        total: best.total,
    })
}

struct BestLine {
    start: usize,
    end: usize,

    terms: usize,

    total: usize,

    ranges: Vec<(usize, usize)>,
}

fn best_line(body: &str, terms: &[String]) -> Option<BestLine> {
    let mut best: Option<BestLine> = None;
    let mut total = 0usize;
    let mut offset = 0usize;

    for line in body.split('\n') {
        let mut ranges: Vec<(usize, usize)> = Vec::new();
        let mut distinct = 0usize;
        for term in terms {
            let before = ranges.len();
            let mut from = 0usize;
            while let Some(at) = find_ci(line, term, from) {
                ranges.push((at, at + term.len()));
                from = at + term.len().max(1);
            }
            if ranges.len() > before {
                distinct += 1;
            }
        }
        total += ranges.len();

        if distinct > 0 && best.as_ref().is_none_or(|b| distinct > b.terms) {
            best = Some(BestLine {
                start: offset,
                end: offset + line.len(),
                terms: distinct,
                total: 0,
                ranges,
            });
        }
        offset += line.len() + 1;
    }

    best.map(|b| BestLine { total, ..b })
}

fn snippet(line: &str, ranges: &[(usize, usize)]) -> Vec<Segment> {
    let ranges = merge(ranges);

    let lead = line.len() - line.trim_start().len();
    let trimmed = line.trim();
    let ranges: Vec<(usize, usize)> = ranges
        .iter()
        .filter(|(s, _)| *s >= lead && *s - lead < trimmed.len())
        .map(|(s, e)| (s - lead, (e - lead).min(trimmed.len())))
        .collect();

    let (window_start, window_end) = window(trimmed, ranges.first().map_or(0, |r| r.0));
    let visible = &trimmed[window_start..window_end];

    let mut out: Vec<Segment> = Vec::new();
    let mut cursor = 0usize;
    for (start, end) in &ranges {
        if *end <= window_start || *start >= window_end {
            continue;
        }
        let start = start.saturating_sub(window_start).max(cursor);
        let end = (end - window_start).min(visible.len());
        if end <= start {
            continue;
        }
        push(&mut out, &visible[cursor..start], false);
        push(&mut out, &visible[start..end], true);
        cursor = end;
    }
    push(&mut out, &visible[cursor..], false);

    if window_start > 0 {
        out.insert(
            0,
            Segment {
                text: "… ".into(),
                hit: false,
            },
        );
    }
    if window_end < trimmed.len() {
        out.push(Segment {
            text: " …".into(),
            hit: false,
        });
    }
    out
}

fn push(out: &mut Vec<Segment>, text: &str, hit: bool) {
    if text.is_empty() {
        return;
    }
    match out.last_mut() {
        Some(last) if last.hit == hit => last.text.push_str(text),
        _ => out.push(Segment {
            text: text.to_owned(),
            hit,
        }),
    }
}

fn window(text: &str, at: usize) -> (usize, usize) {
    if text.chars().count() <= SNIPPET_CHARS {
        return (0, text.len());
    }

    let start = text[..at]
        .char_indices()
        .rev()
        .nth(SNIPPET_LEAD.saturating_sub(1))
        .map_or(0, |(i, _)| i);
    let end = text[start..]
        .char_indices()
        .nth(SNIPPET_CHARS)
        .map_or(text.len(), |(i, _)| start + i);
    (start, end)
}

fn merge(ranges: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let mut sorted = ranges.to_vec();
    sorted.sort_unstable();
    let mut out: Vec<(usize, usize)> = Vec::with_capacity(sorted.len());
    for (start, end) in sorted {
        match out.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => out.push((start, end)),
        }
    }
    out
}

pub fn find_ci(haystack: &str, needle: &str, from: usize) -> Option<usize> {
    let hay = haystack.as_bytes();
    let pat = needle.as_bytes();
    if pat.is_empty() || from > hay.len() || hay.len() - from < pat.len() {
        return None;
    }
    let first = pat[0];
    for i in from..=hay.len() - pat.len() {
        if hay[i].to_ascii_lowercase() != first {
            continue;
        }

        if !haystack.is_char_boundary(i) {
            continue;
        }
        if hay[i..i + pat.len()]
            .iter()
            .zip(pat)
            .all(|(h, p)| h.to_ascii_lowercase() == *p)
        {
            return Some(i);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(pages: &[(&str, &str)]) -> HashMap<String, String> {
        pages
            .iter()
            .map(|(id, body)| ((*id).to_owned(), (*body).to_owned()))
            .collect()
    }

    fn search(pages: &[(&str, &str)], query: &str) -> Vec<ContentHit> {
        run_search(&index(pages), query, 50)
    }

    fn text(hit: &ContentHit) -> String {
        hit.snippet.iter().map(|s| s.text.as_str()).collect()
    }

    fn marks(hit: &ContentHit) -> Vec<&str> {
        hit.snippet
            .iter()
            .filter(|s| s.hit)
            .map(|s| s.text.as_str())
            .collect()
    }

    fn titles(body: &str) -> Vec<String> {
        wiki_link_titles(body)
    }

    #[test]
    fn reads_the_page_a_wikilink_names() {
        assert_eq!(titles("see [[Other]] for more"), ["Other"]);
        assert_eq!(titles("[[Other|shown as this]]"), ["Other"]);
        assert_eq!(titles("[[Other#A heading]]"), ["Other"]);
        assert_eq!(titles("[[  Other  ]]"), ["Other"]);
        assert_eq!(titles("[[A]] then [[B]]"), ["A", "B"]);
    }

    #[test]
    fn ignores_what_is_not_a_wikilink() {
        assert!(titles("[not a wikilink](http://x)").is_empty());
        assert!(titles("[[unclosed").is_empty());
        assert!(titles("[[]]").is_empty());
        assert!(titles("[[|only an alias]]").is_empty());
        assert!(titles("a [[link\nsplit]] over lines").is_empty());
    }

    #[test]
    fn skips_links_written_inside_code() {
        assert!(titles("`[[Other]]`").is_empty());
        assert!(titles("```\n[[Other]]\n```").is_empty());
        assert!(titles("~~~md\n[[Other]]\n~~~").is_empty());
        assert!(titles("``a ` b [[Other]]``").is_empty());

        assert_eq!(titles("```\n[[A]]\n```\n[[B]]"), ["B"]);
        assert_eq!(titles("```\n~~~\n[[A]]\n```"), Vec::<String>::new());
        assert_eq!(titles("`unclosed [[Other]]"), ["Other"]);
    }

    #[test]
    fn finds_the_pages_that_link_to_a_title() {
        let map = index(&[
            ("a", "points at [[Target]]"),
            ("b", "points at [[target|lowercase]]"),
            ("c", "points somewhere else: [[Elsewhere]]"),
            ("d", "no links at all"),
        ]);

        assert_eq!(run_backlinks(&map, "Target"), ["a", "b"]);
        assert_eq!(run_backlinks(&map, "  target  "), ["a", "b"]);
        assert_eq!(run_backlinks(&map, "Elsewhere"), ["c"]);
        assert!(run_backlinks(&map, "Nothing").is_empty());
        assert!(run_backlinks(&map, "   ").is_empty());
    }

    #[test]
    fn a_page_is_listed_once_however_many_times_it_links() {
        let map = index(&[("a", "[[Target]] and [[Target]] and [[Target|again]]")]);
        assert_eq!(run_backlinks(&map, "Target"), ["a"]);
    }

    /// Mirrored verbatim by `matches the Rust scanner` in src/lib/search/wiki-links.test.ts.
    #[test]
    fn same_titles_as_the_typescript_scanner() {
        let cases: &[(&str, &[&str])] = &[
            ("plain [[One]]", &["One"]),
            ("[[One|alias]] and [[Two#section]]", &["One", "Two"]),
            ("[[  Spaced  ]]", &["Spaced"]),
            ("`[[Code]]` but [[Live]]", &["Live"]),
            ("```\n[[Fenced]]\n```\n[[After]]", &["After"]),
            ("   ```\n[[Indented fence]]\n   ```", &[]),
            ("[[a[b]] [[Good]]", &["Good"]),
            ("[[]] [[|alias]] [[Good]]", &["Good"]),
            ("[[unclosed and [[Good]]", &["Good"]),
            ("nested [[Outer [[Inner]]]]", &["Inner"]),
            ("[[Ünïcödé]]", &["Ünïcödé"]),
        ];

        for (body, want) in cases {
            let found = titles(body);
            let found: Vec<&str> = found.iter().map(String::as_str).collect();
            assert_eq!(found.as_slice(), *want, "scanning {body:?}");
        }
    }

    fn ids(hits: &[ContentHit]) -> Vec<&str> {
        hits.iter().map(|h| h.id.as_str()).collect()
    }

    #[test]
    fn matches_case_insensitively_and_snippets_the_line() {
        let hits = search(
            &[("a", "first line\nA TODO item lives here\nlast line")],
            "todo",
        );
        assert_eq!(hits.len(), 1);
        assert_eq!(text(&hits[0]), "A TODO item lives here");
        assert_eq!(marks(&hits[0]), ["TODO"]);
    }

    #[test]
    fn matches_mid_word() {
        let pages = [("a", "Refactoring the serializer")];
        assert_eq!(marks(&search(&pages, "serial")[0]), ["serial"]);
        assert_eq!(marks(&search(&pages, "factor")[0]), ["factor"]);
    }

    #[test]
    fn requires_every_term() {
        let pages = [
            ("both", "alpha\nbeta"),
            ("one", "alpha only"),
            ("neither", "nothing here"),
        ];
        assert_eq!(search(&pages, "alpha").len(), 2);
        assert_eq!(ids(&search(&pages, "alpha beta")), ["both"]);
    }

    #[test]
    fn a_short_query_matches_nothing() {
        assert!(search(&[("a", "a page about everything")], "a").is_empty());
    }

    #[test]
    fn a_blank_query_matches_nothing() {
        assert!(search(&[("a", "anything")], "   ").is_empty());
    }

    #[test]
    fn surrounding_whitespace_is_ignored() {
        let pages = [("a", "alpha and beta")];
        assert_eq!(ids(&search(&pages, "  alpha   beta  ")), ["a"]);
    }

    #[test]
    fn a_verbatim_phrase_outranks_scattered_words() {
        let pages = [
            ("scattered", "project\nsomething else entirely\nalpha"),
            ("verbatim", "notes about project alpha\nmore"),
        ];
        assert_eq!(ids(&search(&pages, "project alpha"))[0], "verbatim");
    }

    #[test]
    fn prefers_the_line_carrying_most_terms() {
        let pages = [
            ("split", "alpha here\nbeta over there"),
            ("together", "alpha and beta on one line"),
        ];
        assert_eq!(ids(&search(&pages, "alpha beta"))[0], "together");
    }

    #[test]
    fn repetition_is_capped() {
        let shouty = format!("{}\nbeta", "alpha ".repeat(40));
        let pages = [("shouty", shouty.as_str()), ("precise", "alpha beta")];
        assert_eq!(ids(&search(&pages, "alpha beta"))[0], "precise");
    }

    #[test]
    fn ties_break_deterministically() {
        let pages = [("b", "needle"), ("a", "needle")];
        assert_eq!(ids(&search(&pages, "needle")), ["a", "b"]);
    }

    #[test]
    fn the_limit_is_respected() {
        let bodies: Vec<(String, String)> = (0..10)
            .map(|i| (format!("p{i}"), "needle".to_owned()))
            .collect();
        let map: HashMap<String, String> = bodies.into_iter().collect();
        assert_eq!(run_search(&map, "needle", 3).len(), 3);
    }

    #[test]
    fn total_counts_the_whole_page_not_the_shown_line() {
        let hits = search(&[("a", "needle one\nneedle two\nneedle three")], "needle");
        assert_eq!(hits[0].total, 3);
    }

    #[test]
    fn picks_the_line_carrying_most_terms_and_marks_each() {
        let hits = search(
            &[("a", "alpha alone\nbeta alone\nalpha and beta together")],
            "alpha beta",
        );
        assert_eq!(text(&hits[0]), "alpha and beta together");
        assert_eq!(marks(&hits[0]), ["alpha", "beta"]);
    }

    #[test]
    fn long_lines_are_windowed_around_the_match() {
        let body = format!("{} NEEDLE {}", "pad ".repeat(80), "tail ".repeat(80));
        let hits = search(&[("a", body.as_str())], "needle");
        let shown = text(&hits[0]);
        assert!(shown.starts_with("… "), "no leading ellipsis: {shown}");
        assert!(shown.ends_with(" …"), "no trailing ellipsis: {shown}");
        assert!(shown.contains("NEEDLE"));
        assert!(shown.chars().count() <= SNIPPET_CHARS + 4);
        assert_eq!(marks(&hits[0]), ["NEEDLE"]);
    }

    #[test]
    fn short_lines_are_left_whole() {
        let hits = search(&[("a", "a short line with a needle in it")], "needle");
        assert_eq!(text(&hits[0]), "a short line with a needle in it");
    }

    #[test]
    fn leading_markdown_indentation_is_trimmed() {
        let hits = search(
            &[("a", "intro\n    - a nested bullet about needles\n")],
            "needle",
        );
        assert_eq!(text(&hits[0]), "- a nested bullet about needles");
        assert_eq!(marks(&hits[0]), ["needle"]);
    }

    #[test]
    fn overlapping_terms_highlight_as_one_run() {
        let hits = search(&[("a", "the pages page")], "page pages");
        assert_eq!(marks(&hits[0]), ["pages", "page"]);
        assert_eq!(text(&hits[0]), "the pages page");
    }

    #[test]
    fn capitalization_is_preserved_in_the_snippet() {
        let hits = search(&[("a", "The Quarterly Planning Doc")], "quarterly");
        assert_eq!(text(&hits[0]), "The Quarterly Planning Doc");
        assert_eq!(marks(&hits[0]), ["Quarterly"]);
    }

    #[test]
    fn segments_always_reconstruct_the_matched_line() {
        let line = "mixed CASE and needle and NEEDLE again";
        let hits = search(&[("a", line)], "needle");
        assert_eq!(text(&hits[0]), line);
    }

    #[test]
    fn accented_text_matches_itself() {
        let hits = search(
            &[("a", "héllo wörld, naïve café notes\nsecond line")],
            "café",
        );
        assert!(text(&hits[0]).contains("café"));
        assert_eq!(marks(&hits[0]), ["café"]);
    }

    #[test]
    fn an_emoji_matches_without_splitting() {
        let hits = search(&[("a", "🎯 target practice")], "🎯 target");
        assert_eq!(marks(&hits[0]), ["🎯", "target"]);
        assert_eq!(text(&hits[0]), "🎯 target practice");
    }

    #[test]
    fn case_folding_stops_at_ascii() {
        assert!(search(&[("a", "CAFÉ")], "café").is_empty());
        assert_eq!(ids(&search(&[("a", "CAFE")], "cafe")), ["a"]);
    }

    #[test]
    fn wide_characters_window_on_whole_characters() {
        let body = format!("{}NEEDLE{}", "🎯".repeat(200), "🎯".repeat(200));
        let hits = search(&[("a", body.as_str())], "needle");
        assert!(text(&hits[0]).contains("NEEDLE"));
    }

    #[test]
    fn a_save_replaces_a_page_body() {
        let idx = SearchIndex::default();
        idx.replace_all(index(&[("a", "before")]));
        idx.upsert("a".into(), "after".into());
        let map = idx.0.read().unwrap();
        assert!(run_search(&*map, "before", 50).is_empty());
        assert_eq!(run_search(&*map, "after", 50).len(), 1);
    }

    #[test]
    fn narrowing_happens_before_the_limit() {
        let mut pages: Vec<(String, String)> = (0..30)
            .map(|i| (format!("elsewhere{i:02}"), "alpha alpha alpha".to_owned()))
            .collect();
        pages.push(("here".into(), "one alpha, far down".into()));
        let map: HashMap<String, String> = pages.into_iter().collect();

        assert!(search_within(&map, "alpha", 20, None)
            .iter()
            .all(|hit| hit.id != "here"));

        let only: HashSet<String> = ["here".to_owned(), "gone".to_owned()].into();
        let hits = search_within(&map, "alpha", 20, Some(&only));
        assert_eq!(
            hits.iter().map(|h| h.id.as_str()).collect::<Vec<_>>(),
            ["here"]
        );
    }

    #[test]
    fn a_rescan_drops_pages_that_are_gone() {
        let idx = SearchIndex::default();
        idx.replace_all(index(&[("a", "alpha"), ("b", "alpha")]));
        assert_eq!(run_search(&*idx.0.read().unwrap(), "alpha", 50).len(), 2);
        idx.replace_all(index(&[("a", "alpha")]));
        assert_eq!(run_search(&*idx.0.read().unwrap(), "alpha", 50).len(), 1);
    }

    #[test]
    #[ignore = "perf budget; run in release via the Performance workflow"]
    fn search_budget_5000_pages() {
        let map: HashMap<String, String> = (0..5000)
            .map(|i| {
                (
                    format!("id{i}"),
                    format!(
                        "# Page {i}\n\n{}\n\nA needle in page {i}.\n",
                        "Some ordinary paragraph text about the work at hand. ".repeat(30)
                    ),
                )
            })
            .collect();

        let mut selective = map.clone();
        selective.insert("rare".to_owned(), "the quetzal roosts here\n".to_owned());
        let start = std::time::Instant::now();
        let hits = run_search(&selective, "quetzal", 50);
        let selective_ms = start.elapsed().as_millis();
        eprintln!(
            "PERF search_notes (selective): {} hits over 5000 pages in {} ms",
            hits.len(),
            selective_ms
        );
        assert_eq!(hits.len(), 1);

        let start = std::time::Instant::now();
        let hits = run_search(&map, "needle", 5000);
        let all_ms = start.elapsed().as_millis();
        eprintln!(
            "PERF search_notes (all match): {} hits over 5000 pages in {} ms",
            hits.len(),
            all_ms
        );
        assert_eq!(hits.len(), 5000);

        assert!(
            selective_ms < 60,
            "selective search regressed: {selective_ms} ms over 5000 pages (budget 60 ms)"
        );
        assert!(
            all_ms < 250,
            "all-match search regressed: {all_ms} ms over 5000 pages (budget 250 ms)"
        );
    }

    #[test]
    #[ignore = "perf budget; run in release via the Performance workflow"]
    fn search_budget_long_notes() {
        const PAGES: usize = 2_000;

        let paragraph = "Longer-form notes run to real paragraphs rather than a line or two, with \
            the sort of detail you write down precisely because you will not remember it: what was \
            decided, who owns it, and the reasoning that made it the obvious choice at the time. ";
        let map: HashMap<String, String> = (0..PAGES)
            .map(|i| {
                let mut body = format!("# Research note {i}\n\n");
                for section in 0..40 {
                    body.push_str(&format!("## Section {section}\n\n{paragraph}\n\n"));
                }

                body.push_str(&format!("The albatross observation for note {i}.\n"));
                (format!("id{i}"), body)
            })
            .collect();

        let bytes: usize = map.values().map(String::len).sum();
        eprintln!(
            "PERF search_notes (long notes): corpus is {} pages, {:.1} MB",
            PAGES,
            bytes as f64 / 1_048_576.0
        );

        let mut selective = map.clone();
        selective.insert("rare".into(), "a lone quetzal roosts here\n".into());
        let start = std::time::Instant::now();
        let hits = run_search(&selective, "quetzal", 50);
        let selective_ms = start.elapsed().as_millis();
        eprintln!("PERF search_notes (long, selective): {} ms", selective_ms);
        assert_eq!(hits.len(), 1);

        let start = std::time::Instant::now();
        let hits = run_search(&map, "albatross", PAGES);
        let common_ms = start.elapsed().as_millis();
        eprintln!("PERF search_notes (long, common): {} ms", common_ms);
        assert_eq!(hits.len(), PAGES);

        let start = std::time::Instant::now();
        let hits = run_search(&map, "albatross observation", PAGES);
        let two_term_ms = start.elapsed().as_millis();
        eprintln!("PERF search_notes (long, two-term): {} ms", two_term_ms);
        assert_eq!(hits.len(), PAGES);

        assert!(
            selective_ms < 300,
            "selective search over long notes regressed: {selective_ms} ms (budget 300 ms)"
        );
        assert!(
            common_ms < 1500,
            "common-term search over long notes regressed: {common_ms} ms (budget 1500 ms)"
        );
        assert!(
            two_term_ms < 2000,
            "two-term search over long notes regressed: {two_term_ms} ms (budget 2000 ms)"
        );
    }

    /// What the ⌘K switcher asks for (20 hits) over the two corpora above; the median of several
    /// runs, so one slow run doesn't decide it.
    #[test]
    #[ignore = "perf budget; run in release via the Performance workflow"]
    fn search_budget_switcher() {
        const LIMIT: usize = 20;
        const RUNS: usize = 11;

        fn median_ms(
            map: &HashMap<String, String>,
            query: &str,
            only: Option<&HashSet<String>>,
            hits: usize,
        ) -> f64 {
            let mut times: Vec<f64> = (0..RUNS)
                .map(|_| {
                    let start = std::time::Instant::now();
                    let found = search_within(map, query, LIMIT, only);
                    let ms = start.elapsed().as_secs_f64() * 1000.0;
                    assert_eq!(found.len(), hits, "{query}");
                    ms
                })
                .collect();
            times.sort_by(|a, b| a.partial_cmp(b).unwrap());
            times[RUNS / 2]
        }

        let paragraph = "Longer-form notes run to real paragraphs rather than a line or two, with \
            the sort of detail you write down precisely because you will not remember it: what was \
            decided, who owns it, and the reasoning that made it the obvious choice at the time. ";
        let mut short: HashMap<String, String> = (0..5000)
            .map(|i| {
                let body = format!(
                    "# Page {i}\n\n{}\n\nA needle in page {i}.\n",
                    "Some ordinary paragraph text about the work at hand. ".repeat(30)
                );
                (format!("id{i}"), body)
            })
            .collect();
        let mut long: HashMap<String, String> = (0..2000)
            .map(|i| {
                let mut body = format!("# Research note {i}\n\n");
                for section in 0..40 {
                    body.push_str(&format!("## Section {section}\n\n{paragraph}\n\n"));
                }
                body.push_str(&format!("The albatross observation for note {i}.\n"));
                (format!("id{i}"), body)
            })
            .collect();
        short.insert("rare".into(), "the quetzal roosts here\n".into());
        long.insert("rare".into(), "a lone quetzal roosts here\n".into());

        // Budgets are about 3x a laptop's median, for CI runners.
        let cases = [
            ("5000 pages / 8 MB", &short, "quetzal", 1, 30.0),
            ("5000 pages / 8 MB", &short, "needle", LIMIT, 70.0),
            ("5000 pages / 8 MB", &short, "needle in page", LIMIT, 160.0),
            ("2000 pages / 20 MB", &long, "quetzal", 1, 70.0),
            ("2000 pages / 20 MB", &long, "albatross", LIMIT, 160.0),
            (
                "2000 pages / 20 MB",
                &long,
                "albatross observation",
                LIMIT,
                380.0,
            ),
        ];
        for (corpus, map, query, hits, budget) in cases {
            let ms = median_ms(map, query, None, hits);
            eprintln!("PERF search_notes (switcher, {corpus}, {query:?}): {ms:.1} ms");
            assert!(
                ms < budget,
                "{corpus}, {query:?}: {ms:.1} ms (budget {budget} ms)"
            );
        }

        // One context of five: the switcher passes only its pages.
        let context: HashSet<String> = (0..400).map(|i| format!("id{i}")).collect();
        let ms = median_ms(&long, "albatross observation", Some(&context), LIMIT);
        eprintln!(
            "PERF search_notes (switcher, 400 of 2000 pages / 20 MB, \"albatross observation\"): \
             {ms:.1} ms"
        );
        assert!(ms < 80.0, "scoped search: {ms:.1} ms (budget 80 ms)");
    }
}
