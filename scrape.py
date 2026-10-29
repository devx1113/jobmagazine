"""Full scrape of ライター名鑑 (https://jobmagazine.jp/meikan/writer/list/).

Collects every writer (from the list page and from every tag page), every tag
(sidebar, homepage, and every genre label on writer profiles), and every page
of each tag, then writes CSVs to ./output/.
"""
import csv
import re
import time
from collections import OrderedDict
from pathlib import Path
from urllib.parse import quote, unquote, urljoin, urlsplit

import requests
from bs4 import BeautifulSoup, Comment

BASE = "https://jobmagazine.jp/meikan/"
LIST_URL = BASE + "writer/list/"
DELAY = 0.6
OUT = Path(__file__).parent / "output"

session = requests.Session()
session.headers["User-Agent"] = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/130.0 Safari/537.36"
)


def fetch(url):
    """Return (status, final_url, soup, raw_html); retries transient errors."""
    for attempt in range(4):
        try:
            r = session.get(url, timeout=30)
            time.sleep(DELAY)
            if r.status_code >= 500:
                raise requests.HTTPError(r.status_code)
            r.encoding = "utf-8"
            return r.status_code, r.url, BeautifulSoup(r.text, "html.parser"), r.text
        except (requests.RequestException, requests.HTTPError) as e:
            print(f"  retry {attempt + 1} {url}: {e}")
            time.sleep(2 * (attempt + 1))
    return None, url, None, ""


def norm_url(url):
    """Canonical form for de-duplication: decoded path, no trailing slash."""
    p = urlsplit(url)
    return f"https://{p.netloc}{unquote(p.path).rstrip('/')}"


def tag_url(name):
    return BASE + "tags/" + quote(name) + "/"


def wp_slug(name):
    """WordPress-style slug ("M&A" -> "ma", "LGBTQ+" -> "lgbtq")."""
    s = re.sub(r"[^\w\s-]", "", name.lower())
    return re.sub(r"[\s_]+", "-", s).strip("-")


def text(el):
    return el.get_text(" ", strip=True) if el else ""


def harvest_tags(soup, page_url, tags):
    """Add every /meikan/tags/<name>/ link on the page to `tags`."""
    for a in soup.find_all("a", href=True):
        full = urljoin(page_url, a["href"])
        m = re.search(r"/meikan/tags/([^/?#]+)", unquote(full))
        if m:
            name = m.group(1)
            tags.setdefault(name, {"sources": set()})
            tags[name]["sources"].add("link")


def sidebar_categories(soup):
    """Map tag name -> sidebar category heading (e.g. 【経済】)."""
    cats = {}
    box = soup.find(id="taglist")
    if not box:
        return cats
    for h3 in box.find_all("h3"):
        ul = h3.find_next_sibling("ul")
        for a in ul.find_all("a", href=True) if ul else []:
            m = re.search(r"/tags/([^/]+)/", unquote(a["href"]))
            if m:
                cats[m.group(1)] = h3.get_text(strip=True).strip("【】")
    return cats


def parse_writer(url, soup, raw):
    d = soup.find(id="writer_detail")
    if not d:
        return None
    head = d.find("header")
    info = head.find("div") if head else d
    img = head.find("img") if head else None
    work_style = re.search(r"業務形態：([^<]*)</strong>", raw)

    # Profile body: the first <p> directly under the article, line breaks kept.
    bio = ""
    p = d.find("p", recursive=False)
    if p:
        # Source newlines render as nothing in Japanese text; only <br> is a line break.
        for s in p.find_all(string=True):
            s.replace_with(re.sub(r"\s*\n\s*", "", s))
        for br in p.find_all("br"):
            br.replace_with("\n")
        bio = "\n".join(line.strip() for line in p.get_text().splitlines()).strip()
        bio = re.sub(r"\n{3,}", "\n\n", bio)

    # Genres: un-indented <li> is a category, indented <li> belongs to it.
    genre_pairs, categories, cur = [], [], ""
    g = d.find(id="genre")
    for li in g.find_all("li") if g else []:
        raw_label = li.get_text().replace("​", "")
        # Some entries are two labels joined by a tab: "sub<TAB>NextCategory".
        for n, part in enumerate(raw_label.split("\t")):
            label = part.strip()
            if not label:
                continue
            if n == 0 and raw_label[:1].isspace():
                genre_pairs.append(f"{cur} > {label}" if cur else label)
            else:
                cur = label
                categories.append(label)
    genre_labels = categories + [x.split(" > ")[-1] for x in genre_pairs]
    # Free-text labels like "本、ジェンダー、料理" may map to several tags.
    genre_labels += [p.strip() for x in list(genre_labels)
                     for p in re.split(r"[、,，/／]", x) if p.strip() and p.strip() != x]

    services = [
        li.get_text(strip=True).replace("​", "")
        for li in (d.find(id="irai").find_all("li") if d.find(id="irai") else [])
    ]

    extra = {}
    for dl in d.find_all("dl"):
        for dt in dl.find_all("dt"):
            dd = dt.find_next_sibling("dd")
            extra[dt.get_text(strip=True)] = text(dd)

    sns = OrderedDict()
    for a in d.select("#sns a[href]"):
        im = a.find("img")
        key = (im.get("alt") if im else "") or urlsplit(a["href"]).netloc
        sns.setdefault(key.lower(), []).append(a["href"])

    portfolio, contact_url, contact_id = [], "", ""
    for li in d.select("#contact li"):
        a = li.find("a", href=True)
        if not a:
            continue
        href = urljoin(url, a["href"])
        if "mail" in li.get("class", []):
            contact_url = href
            m = re.search(r"to=(\d+)", href)
            contact_id = m.group(1) if m else ""
        else:
            portfolio.append(f"{a.get_text(strip=True)}: {href}")

    return {
        "writer_id": contact_id,
        "name": text(info.find("h1")),
        # bs4's get_text() skips <rt> content, so read its string directly.
        "kana": (info.find("rt").string or "").strip() if info.find("rt") else text(info.find("ruby")),
        "area": text(info.find("b")),
        "invoice": text(info.find("small")),
        "work_style": work_style.group(1).strip() if work_style else "",
        "catchcopy": text(info.find("h2")),
        "profile_image": img["src"] if img and img.has_attr("src") else "",
        "profile": bio,
        "genre_categories": " | ".join(categories),
        "genres": " | ".join(genre_pairs),
        "services": " | ".join(services),
        "apps": extra.pop("対応アプリ", ""),
        "other_details": " | ".join(f"{k}: {v}" for k, v in extra.items()),
        "sns": sns,
        "portfolio": " | ".join(portfolio),
        "contact_url": contact_url,
        "_genre_labels": genre_labels,
    }


def parse_tag_page(page_url, soup):
    """Return (writer cards, pagination urls) for one tag page."""
    cards = []
    box = soup.find(id="writers")
    for art in box.find_all("article", class_=re.compile(r"^a\d")) if box else []:
        a = art.find("a", href=True)
        if not a:
            continue
        im = a.find("img")
        cards.append({
            "url": urljoin(page_url, a["href"]),
            "name": text(a.find("h3")),
            "kana": text(a.find("ruby")),
            "area": text(a.find("aside")),
            "catchcopy": text(a.find("h2")),
            "thumbnail": im["src"] if im and im.has_attr("src") else "",
        })
    pages = set()
    main = soup.find(id="main") or soup
    for a in main.find_all("a", href=True):
        full = urljoin(page_url, a["href"])
        if re.search(r"/page/\d+/?|[?&]paged=\d+", full) and "/tags/" in full:
            pages.add(full)
    return cards, pages


def main():
    OUT.mkdir(exist_ok=True)
    writers = OrderedDict()   # norm_url -> record
    tags = OrderedDict()      # tag name -> info
    tag_members = OrderedDict()  # tag -> list of norm_urls (in page order)
    tag_cats = {}

    def add_writer(url, **seed):
        key = norm_url(url)
        rec = writers.setdefault(key, {"url": url, "found_on": set()})
        for k, v in seed.items():
            if k == "found_on":
                rec["found_on"].add(v)
            elif v and not rec.get(k):
                rec[k] = v
        return key

    # 1. Writer list page.
    print("List page")
    _, _, soup, _ = fetch(LIST_URL)
    tag_cats.update(sidebar_categories(soup))
    harvest_tags(soup, LIST_URL, tags)
    for h2 in soup.select("#writer_all h2"):
        ul = h2.find_next_sibling("ul")
        for a in ul.find_all("a", href=True) if ul else []:
            label = a.get_text(strip=True)
            name, _, pref = label.rpartition("　")
            add_writer(urljoin(LIST_URL, a["href"]), list_name=name or label,
                       list_prefecture=pref if name else "", kana_group=h2.get_text(strip=True),
                       found_on="list")
    print(f"  {len(writers)} writers")

    # 2. Homepage (extra tags + pickup writers).
    print("Home page")
    _, _, soup, _ = fetch(BASE)
    harvest_tags(soup, BASE, tags)

    # 3/4. Alternate between writer pages and tag pages until nothing new appears.
    done_writers, done_tags = set(), set()
    while True:
        todo_w = [k for k in writers if k not in done_writers]
        todo_t = [t for t in tags if t not in done_tags]
        if not todo_w and not todo_t:
            break
        for i, key in enumerate(todo_w, 1):
            rec = writers[key]
            print(f"Writer {i}/{len(todo_w)} {rec['url']}")
            status, final, soup, raw = fetch(rec["url"])
            done_writers.add(key)
            rec["http_status"] = status
            if not soup or status != 200:
                continue
            rec["final_url"] = final
            data = parse_writer(final, soup, raw)
            if data:
                rec.update(data)
                for label in data["_genre_labels"]:
                    tags.setdefault(label, {"sources": set()})
                    tags[label]["sources"].add("genre")
            harvest_tags(soup, final, tags)

        for i, name in enumerate(todo_t, 1):
            done_tags.add(name)
            first = tag_url(name)
            queue, seen_pages, members = [first], set(), []
            tags[name].update(url=first, pages=0, status=None)
            while queue:
                page = queue.pop(0)
                if norm_url(page) in seen_pages:
                    continue
                seen_pages.add(norm_url(page))
                status, final, soup, _ = fetch(page)
                if page == first and status == 404 and wp_slug(name) not in ("", name):
                    first = page = tag_url(wp_slug(name))
                    print(f"  404, retrying as slug {page}")
                    status, final, soup, _ = fetch(page)
                    tags[name]["url"] = first
                if page == first:
                    tags[name]["status"] = status
                print(f"Tag {i}/{len(todo_t)} {name} [{status}] {page}")
                # A missing tag returns 404 with a filler "pickup" list; ignore it.
                if status != 200 or not soup:
                    continue
                tags[name]["pages"] += 1
                heading = soup.select_one("#writers > h2")
                tags[name]["heading"] = text(heading)
                harvest_tags(soup, final, tags)
                cards, more = parse_tag_page(final, soup)
                for c in cards:
                    key = add_writer(c.pop("url"), found_on=f"tag:{name}",
                                     **{f"card_{k}": v for k, v in c.items()})
                    if key not in members:
                        members.append(key)
                queue.extend(p for p in more if norm_url(p) not in seen_pages)
            tag_members[name] = members

    # Different candidate names can resolve to the same tag (e.g. "LGBTQ" and "lgbtq"):
    # same heading and same member list means same tag; keep the first as canonical.
    canonical = {}
    for t in list(tag_members):
        sig = (tags[t].get("heading"), tuple(tag_members[t]))
        if sig in canonical:
            keep = canonical[sig]
            tags[keep].setdefault("aliases", []).append(t)
            tags[keep]["sources"] |= tags[t]["sources"]
            del tag_members[t], tags[t]
        elif tags[t].get("status") == 200:
            canonical[sig] = t

    # Writer -> tags.
    writer_tags = {k: [] for k in writers}
    for t, members in tag_members.items():
        for k in members:
            writer_tags[k].append(t)

    # Merge records that turned out to be the same writer under two URLs.
    by_id = OrderedDict()
    for key, rec in writers.items():
        if rec.get("http_status") != 200 or "name" not in rec:
            by_id[key] = (rec, writer_tags[key])
            continue
        wid = rec.get("writer_id") or norm_url(rec.get("final_url", key))
        if wid in by_id:
            old, old_tags = by_id[wid]
            old["found_on"] |= rec["found_on"]
            old.setdefault("alt_urls", set()).add(rec["url"])
            old_tags.extend(t for t in writer_tags[key] if t not in old_tags)
        else:
            by_id[wid] = (rec, list(writer_tags[key]))

    sns_keys = sorted({s for rec, _ in by_id.values() for s in rec.get("sns", {})})
    cols = [
        "writer_id", "name", "kana", "list_name", "kana_group", "list_prefecture", "area",
        "card_area", "invoice", "work_style", "catchcopy", "profile", "genre_categories",
        "genres", "services", "apps", "other_details", "portfolio",
    ] + [f"sns_{s}" for s in sns_keys] + [
        "contact_url", "profile_image", "card_thumbnail", "tag_count", "tags",
        "url", "final_url", "alt_urls", "in_list_page", "http_status",
    ]
    with open(OUT / "writers.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for rec, tlist in by_id.values():
            row = {k: rec.get(k, "") for k in cols}
            for s in sns_keys:
                row[f"sns_{s}"] = " | ".join(rec.get("sns", {}).get(s, []))
            row["name"] = rec.get("name") or rec.get("card_name") or rec.get("list_name", "")
            row["kana"] = rec.get("kana") or rec.get("card_kana", "")
            row["catchcopy"] = rec.get("catchcopy") or rec.get("card_catchcopy", "")
            row["tags"] = " | ".join(tlist)
            row["tag_count"] = len(tlist)
            row["alt_urls"] = " | ".join(sorted(rec.get("alt_urls", [])))
            row["in_list_page"] = "yes" if "list" in rec["found_on"] else "no"
            w.writerow(row)

    with open(OUT / "writer_tags.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["tag", "position_on_tag_page", "writer_id", "writer_name", "writer_url"])
        for t, members in tag_members.items():
            for pos, k in enumerate(members, 1):
                rec = writers[k]
                w.writerow([t, pos, rec.get("writer_id", ""),
                            rec.get("name") or rec.get("card_name", ""), rec["url"]])

    with open(OUT / "tags.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["tag", "sidebar_category", "page_heading", "writer_count", "pages_scraped",
                    "http_status", "discovered_via", "aliases", "url"])
        for t, info in tags.items():
            w.writerow([t, tag_cats.get(t, ""), info.get("heading", ""),
                        len(tag_members.get(t, [])), info.get("pages", 0), info.get("status"),
                        " | ".join(sorted(info["sources"])), " | ".join(info.get("aliases", [])),
                        info.get("url", tag_url(t))])

    live = sum(1 for i in tags.values() if i.get("status") == 200)
    print(f"\nWriters: {len(by_id)} | Tags tried: {len(tags)} (live: {live}) "
          f"| Tag memberships: {sum(len(m) for m in tag_members.values())}")


if __name__ == "__main__":
    main()
