"""
Crawl4AI 背调脚本 — 抓取公司网站提取关键信息

用法:
  # 已知公司网站（直接抓）
  python scripts/crawl4ai_backcheck.py <url> [--json]

  # 无 website：按公司名 + 国家，用搜索引擎搜出官网再抓
  python scripts/crawl4ai_backcheck.py --company "LINQps" --country "middle-east" [--json]

  # 带业务线信息（增强搜索精度）
  python scripts/crawl4ai_backcheck.py --company "ABC Corp" --country "USA" --business "furniture wholesale" [--json]
"""
import sys
import json
import asyncio
import re
from urllib.parse import unquote, urlparse, quote_plus
from crawl4ai import AsyncWebCrawler, CrawlerRunConfig, BrowserConfig, CacheMode

# 搜索结果里要排除的域名（目录站/社交平台/问答站/论坛/政府网站，不是公司官网）
EXCLUDED_DOMAINS = (
    # 社交平台
    'linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
    'youtube.com', 'tiktok.com', 'pinterest.com', 'reddit.com',
    # 问答/论坛
    'quora.com', 'zhihu.com', 'baidu.com', 'tieba.baidu.com', 'zhidao.baidu.com',
    'yahoo.com', 'answers.com', 'forum', 'pcbeta.com', 'bbs.',
    'v2ex.com', 'douban.com', 'tianya.cn', 'mop.com', 'hupu.com',
    # 新闻/媒体
    'bloomberg.com', 'reuters.com', 'techcrunch.com', 'forbes.com', 'medium.com',
    'bbc.com', 'cnn.com', 'nytimes.com', 'wsj.com',
    # 百科
    'wikipedia.org', 'baike.baidu.com', 'wiki.',
    # B2B平台/目录站
    'yellowpages.com', 'go4worldbusiness.com', 'alibaba.com', 'made-in-china.com',
    'globalsources.com', 'thomasnet.com', 'kompass.com', 'dnb.com', 'zoominfo.com',
    'apollo.io', 'ibaba.com', 'tradekey.com', 'exportersindia.com',
    # 评价网站
    'yelp.com', 'trustpilot.com', 'glassdoor.com', 'indeed.com',
    # 搜索引擎
    'duckduckgo.com', 'google.com', 'bing.com', 'baidu.com',
    # 电商
    'amazon.com', 'ebay.com', 'walmart.com', 'target.com', 'aliexpress.com',
    # 中国政府/备案网站
    'beian.miit.gov.cn', 'beian.mps.gov.cn', 'miit.gov.cn',
    'dxzhgl.miit.gov.cn', '.gov.cn', '.gov',
    # 其他
    'crunchbase.com', 'glassdoor.', 'archive.org', 'web.archive.org',
)


async def backcheck_url(url: str) -> dict:
    """抓取单个 URL 并返回内容"""
    browser_config = BrowserConfig(headless=True, verbose=False)
    run_config = CrawlerRunConfig(
        word_count_threshold=10,
        page_timeout=15000,
        verbose=False,
        cache_mode=CacheMode.BYPASS,
    )

    async with AsyncWebCrawler(config=browser_config) as crawler:
        result = await crawler.arun(url=url, config=run_config)

        if not result.success:
            return {"success": False, "error": f"Failed to crawl: {result.error_message}"}

        # 尝试多种方式获取内容
        markdown = ""
        if hasattr(result, 'markdown'):
            md = result.markdown
            if hasattr(md, 'fit_markdown') and md.fit_markdown:
                markdown = md.fit_markdown
            elif hasattr(md, 'raw_markdown') and md.raw_markdown:
                markdown = md.raw_markdown
            elif isinstance(md, str):
                markdown = md

        # 如果还是空，用html
        if not markdown and result.html:
            markdown = result.html[:50000]

        return {
            "success": True,
            "url": url,
            "title": result.metadata.get("title", "") if result.metadata else "",
            "markdown": markdown[:50000],
            "wordCount": len(markdown.split()) if markdown else 0,
        }


def _parse_ddg_links(html: str) -> list:
    """从 DuckDuckGo HTML 版搜索结果里提取候选链接"""
    candidates = []
    for m in re.finditer(r'uddg=([^&"\']+)', html):
        try:
            raw = unquote(m.group(1))
            if not raw.startswith('http'):
                continue
            host = (urlparse(raw).hostname or '').lower().replace('www.', '')
            if not host:
                continue
            if any(ex in host for ex in EXCLUDED_DOMAINS):
                continue
            candidates.append(raw)
        except Exception:
            continue
    return _dedupe(candidates)


def _parse_bing_links(html: str) -> list:
    """从 Bing 搜索结果里提取候选链接"""
    candidates = []
    # Bing 结果链接在 <a href="..."> 里，带 bing.com/redir?...
    for m in re.finditer(r'href="(https?://[^"]+)"', html):
        try:
            raw = m.group(1)
            if 'bing.com' in raw or 'microsoft.com' in raw:
                continue
            if not raw.startswith('http'):
                continue
            host = (urlparse(raw).hostname or '').lower().replace('www.', '')
            if not host:
                continue
            if any(ex in host for ex in EXCLUDED_DOMAINS):
                continue
            candidates.append(raw)
        except Exception:
            continue
    return _dedupe(candidates)


def _parse_google_links(html: str) -> list:
    """从 Google 搜索结果里提取候选链接"""
    candidates = []
    for m in re.finditer(r'href="/url\?q=([^&"]+)', html):
        try:
            raw = unquote(m.group(1))
            if not raw.startswith('http'):
                continue
            host = (urlparse(raw).hostname or '').lower().replace('www.', '')
            if not host:
                continue
            if any(ex in host for ex in EXCLUDED_DOMAINS):
                continue
            candidates.append(raw)
        except Exception:
            continue
    return _dedupe(candidates)


def _dedupe(lst: list) -> list:
    seen = set()
    result = []
    for item in lst:
        if item not in seen:
            seen.add(item)
            result.append(item)
    return result


def _is_company_url(url: str, company: str) -> bool:
    """判断 URL 是否可能是该公司的官网"""
    host = (urlparse(url).hostname or '').lower().replace('www.', '')
    company_words = re.findall(r'[a-z]+', company.lower())
    # 公司名关键词出现在域名中
    return any(w in host for w in company_words if len(w) > 2)


def _score_company_url(url: str, company: str) -> int:
    """给 URL 打分，越高越可能是官网。0 = 不是官网。"""
    host = (urlparse(url).hostname or '').lower().replace('www.', '')
    path = urlparse(url).path.lower()
    company_words = [w for w in re.findall(r'[a-z]+', company.lower()) if len(w) > 2]

    # 预排除：已经在 EXCLUDED_DOMAINS 里的直接 -100
    if any(ex in host for ex in EXCLUDED_DOMAINS):
        return -100

    score = 0
    # 域名含公司名关键词 → 高分
    if any(w in host for w in company_words):
        score += 10
    # 纯顶级域名（company.com）→ 加分
    parts = host.split('.')
    if len(parts) == 2:
        score += 5
    # 排除明显非官网的路径
    if any(p in path for p in ['/question/', '/answer/', '/p/', '/article/', '/blog/', '/viewthread-', '/question/']):
        score -= 20
    # 排除子页面太多
    if path.count('/') > 2:
        score -= 3
    # 排除中文路径
    if re.search(r'[\u4e00-\u9fa5]', url):
        score -= 10
    return score


def _pick_best_url(candidates: list, company: str) -> str | None:
    """从候选列表中选出最可能是官网的 URL"""
    scored = [(url, _score_company_url(url, company)) for url in candidates]
    scored.sort(key=lambda x: x[1], reverse=True)
    # 只选正分的
    for url, s in scored:
        if s > 0:
            return url
    return scored[0][0] if scored else None


async def search_ddg(query: str) -> list:
    """用 DuckDuckGo HTML 搜索"""
    ddg_url = f'https://html.duckduckgo.com/html/?q={quote_plus(query)}'
    browser_config = BrowserConfig(headless=True, verbose=False)
    run_config = CrawlerRunConfig(word_count_threshold=10, cache_mode=CacheMode.BYPASS)
    async with AsyncWebCrawler(config=browser_config) as crawler:
        result = await crawler.arun(url=ddg_url, config=run_config)
        if not result.success:
            return []
        return _parse_ddg_links(result.html or "")


async def search_bing(query: str) -> list:
    """用 Bing 搜索"""
    bing_url = f'https://www.bing.com/search?q={quote_plus(query)}'
    browser_config = BrowserConfig(headless=True, verbose=False)
    run_config = CrawlerRunConfig(word_count_threshold=10, cache_mode=CacheMode.BYPASS)
    async with AsyncWebCrawler(config=browser_config) as crawler:
        result = await crawler.arun(url=bing_url, config=run_config)
        if not result.success:
            return []
        return _parse_bing_links(result.html or "")


async def search_google(query: str) -> list:
    """用 Google 搜索"""
    google_url = f'https://www.google.com/search?q={quote_plus(query)}'
    browser_config = BrowserConfig(headless=True, verbose=False)
    run_config = CrawlerRunConfig(word_count_threshold=10, cache_mode=CacheMode.BYPASS)
    async with AsyncWebCrawler(config=browser_config) as crawler:
        result = await crawler.arun(url=google_url, config=run_config)
        if not result.success:
            return []
        return _parse_google_links(result.html or "")


async def find_company_url(company: str, country: str = "", business: str = "") -> dict:
    """多引擎搜索公司官网，优先匹配域名含公司名的 URL。
    依次尝试: DDG → Bing → Google，每次尝试多种查询组合。"""
    # 构建多种查询组合
    queries = []
    # 精确匹配
    if country and business:
        queries.append(f'"{company}" {country} {business}')
    if country:
        queries.append(f'"{company}" {country}')
    queries.append(f'"{company}" official website')
    queries.append(f'"{company}"')

    all_candidates = []
    engines_tried = []

    for query in queries:
        # 尝试 DDG
        candidates = await search_ddg(query)
        if candidates:
            engines_tried.append(f"DDG:{query}")
            all_candidates.extend(candidates)
            # 如果有域名匹配公司名的，优先返回
            for c in candidates:
                if _is_company_url(c, company):
                    return {
                        "success": True,
                        "searchEngine": "duckduckgo",
                        "query": query,
                        "candidates": _dedupe(all_candidates)[:5],
                        "picked": c,
                    }
            if len(all_candidates) >= 3:
                break
            await asyncio.sleep(0.5)

        # 尝试 Bing
        candidates = await search_bing(query)
        if candidates:
            engines_tried.append(f"Bing:{query}")
            all_candidates.extend(candidates)
            for c in candidates:
                if _is_company_url(c, company):
                    return {
                        "success": True,
                        "searchEngine": "bing",
                        "query": query,
                        "candidates": _dedupe(all_candidates)[:5],
                        "picked": c,
                    }
            if len(all_candidates) >= 3:
                break
            await asyncio.sleep(0.5)

        # 尝试 Google
        candidates = await search_google(query)
        if candidates:
            engines_tried.append(f"Google:{query}")
            all_candidates.extend(candidates)
            for c in candidates:
                if _is_company_url(c, company):
                    return {
                        "success": True,
                        "searchEngine": "google",
                        "query": query,
                        "candidates": _dedupe(all_candidates)[:5],
                        "picked": c,
                    }
            if len(all_candidates) >= 3:
                break
            await asyncio.sleep(0.5)

    unique = _dedupe(all_candidates)
    if not unique:
        return {
            "error": "所有搜索引擎均未搜到匹配的官网",
            "enginesTried": engines_tried,
            "candidates": [],
        }

    # 智能选择最可能是官网的 URL
    best = _pick_best_url(unique, company)

    # 检查是否有高相关性结果（域名含公司名）
    company_words = [w for w in re.findall(r'[a-z]+', company.lower()) if len(w) > 2]
    has_relevant = any(
        _score_company_url(url, company) > 0
        for url in unique
    )

    if not has_relevant and best:
        # 没有高相关性结果 → 返回失败，让后端走 LLM 兜底
        return {
            "success": False,
            "error": f"搜索到 {len(unique)} 个结果但均与 {company} 无关",
            "searchEngine": "multi",
            "query": queries[0],
            "candidates": unique[:5],
            "confidence": "low",
        }

    return {
        "success": True,
        "searchEngine": "multi",
        "query": queries[0],
        "candidates": unique[:5],
        "picked": best or unique[0],
        "confidence": "high",
    }


def main():
    as_json = "--json" in sys.argv

    # 无 website 模式：按公司名搜
    if "--company" in sys.argv:
        i = sys.argv.index("--company")
        if i + 1 >= len(sys.argv):
            print("Usage: --company requires a value")
            sys.exit(1)
        company = sys.argv[i + 1]
        country = ""
        business = ""
        if "--country" in sys.argv:
            j = sys.argv.index("--country")
            if j + 1 < len(sys.argv):
                country = sys.argv[j + 1]
        if "--business" in sys.argv:
            j = sys.argv.index("--business")
            if j + 1 < len(sys.argv):
                business = sys.argv[j + 1]

        # 步骤 1: 搜官网
        search_result = asyncio.run(find_company_url(company, country, business))
        picked_url = search_result.get("picked")
        if not picked_url:
            payload = {
                "success": False,
                "stage": "company-search",
                "company": company,
                "country": country,
                "error": search_result.get("error", "未搜到匹配的官网"),
                "candidates": search_result.get("candidates", []),
                "enginesTried": search_result.get("enginesTried", []),
            }
            print(json.dumps(payload, ensure_ascii=False, indent=2))
            return

        # 步骤 2: 抓官网（失败时尝试下一个候选）
        candidates = search_result.get("candidates", [picked_url])
        backcheck = asyncio.run(backcheck_url(picked_url))
        tried_urls = [picked_url]

        # 如果第一个 URL 失败，尝试后续候选
        if not backcheck.get("success") and len(candidates) > 1:
            for alt_url in candidates[1:3]:  # 最多再试 2 个
                if alt_url in tried_urls:
                    continue
                tried_urls.append(alt_url)
                alt_result = asyncio.run(backcheck_url(alt_url))
                if alt_result.get("success"):
                    backcheck = alt_result
                    picked_url = alt_url
                    break

        backcheck["companySearch"] = {
            "company": company,
            "country": country,
            "business": business,
            "searchEngine": search_result.get("searchEngine"),
            "query": search_result.get("query"),
            "candidates": candidates,
            "resolvedUrl": picked_url,
            "triedUrls": tried_urls,
        }
        backcheck["source"] = "company-search"

        if as_json:
            print(json.dumps(backcheck, ensure_ascii=False, indent=2))
        else:
            if backcheck.get("error"):
                print(f"Error after search: {backcheck['error']}")
            else:
                print(f"Resolved URL: {picked_url}")
                print(f"Title: {backcheck.get('title', 'N/A')}")
                print(f"Words: {backcheck.get('wordCount', 0)}")
        return

    # 已知 url 模式（原行为）
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print("Usage: python crawl4ai_backcheck.py <url> [--json]\n"
              "       python crawl4ai_backcheck.py --company \"X\" [--country \"Y\"] [--business \"Z\"] [--json]")
        sys.exit(1)

    url = args[0]
    result = asyncio.run(backcheck_url(url))
    result["source"] = "website"

    if as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        if result.get("error"):
            print(f"Error: {result['error']}")
        else:
            print(f"Title: {result.get('title', 'N/A')}")
            print(f"Words: {result.get('wordCount', 0)}")
            print(f"Content length: {len(result.get('markdown', ''))}")
            print("---")
            print(result.get("markdown", "")[:2000])


if __name__ == "__main__":
    # Windows GBK stdout fix: ensure UTF-8 for JSON output with Unicode chars
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    elif hasattr(sys.stdout, 'buffer'):
        sys.stdout = sys.stdout.buffer
    main()
