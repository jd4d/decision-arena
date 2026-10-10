import { useEffect } from "react";
import { MatchBrowser } from "./browser/MatchBrowser.tsx";
import { HomePage, REPO_URL } from "./home/HomePage.tsx";
import { useTransportKind } from "./lib/api.ts";
import { useRoute, type Route } from "./lib/router.ts";
import { LivePage } from "./live/LivePage.tsx";
import { MatchView } from "./match/MatchView.tsx";
import { GitHubMark, MethodologyPage } from "./methodology/MethodologyPage.tsx";
import { ResultsPage } from "./results/ResultsPage.tsx";
import { RunPage } from "./run/RunPage.tsx";

const SITE_TITLE = "Decision Arena AI";

function routeKey(r: Route): string {
  switch (r.page) {
    case "match": return `m/${r.runId}/${r.matchId}`;
    case "live": return `l/${r.matchId}`;
    case "methodology": return "methodology";
    default: return r.page;
  }
}

function routeTitle(r: Route): string {
  switch (r.page) {
    case "match": return `${r.matchId} · Decision Arena AI`;
    case "live": return "Live match · Decision Arena AI";
    case "run": return "Run a match · Decision Arena AI";
    case "matches": return "Matches · Decision Arena AI";
    case "results": return "Results · Decision Arena AI";
    case "methodology": return "Methodology · Decision Arena AI";
    default: return SITE_TITLE;
  }
}

export function App() {
  const route = useRoute();
  const key = routeKey(route);
  const mock = useTransportKind() === "mock";

  useEffect(() => {
    document.title = routeTitle(route);
    if (route.page !== "match" && !(route.page === "methodology" && route.section)) window.scrollTo({ top: 0 });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const on = (...pages: Route["page"][]) => (pages.includes(route.page) ? "is-on" : "");
  const stage = route.page === "match" || route.page === "live";

  return (
    <div className={`app app--${route.page} ${stage ? "app--stage" : ""}`}>
      <header className="topnav">
        <a className="brand" href="#/" aria-label="Decision Arena home">
          <svg className="brand__mark" viewBox="0 0 32 32" aria-hidden>
            <circle cx="16" cy="16" r="9" fill="none" stroke="#38d9f5" strokeWidth="2.4" />
            <path d="M16 2.5v7M16 22.5v7M2.5 16h7M22.5 16h7" stroke="#ff9d3c" strokeWidth="2.4" strokeLinecap="round" />
            <circle cx="16" cy="16" r="2.2" fill="#e8eef6" />
          </svg>
          <span className="brand__word">Decision<b>Arena</b></span>
        </a>
        <nav className="topnav__links" aria-label="Main">
          <a href="#/run" className={`topnav__run ${on("run", "live")}`}>Run</a>
          <a href="#/matches" className={on("matches", "match")}>Matches</a>
          <a href="#/results" className={on("results")}>Results</a>
          <a href="#/methodology" className={on("methodology")}>Methodology</a>
        </nav>
        <div className="topnav__right">
          <span className="topnav__lineup"><i className="sw sw--jev" />Jev 1.13 <span>vs</span> <i className="sw sw--ms" />Microsoft Decision 1</span>
          <a className="topnav__gh" href={REPO_URL} target="_blank" rel="noreferrer" aria-label="Decision Arena source code on GitHub (opens in a new tab)" title="Source on GitHub">
            <GitHubMark size={18} />
          </a>
        </div>
      </header>
      <main className="page" key={key}>
        {route.page === "match" ? (
          <MatchView runId={route.runId} matchId={route.matchId} t={route.t} />
        ) : route.page === "live" ? (
          <LivePage matchId={route.matchId} />
        ) : route.page === "run" ? (
          <RunPage />
        ) : route.page === "matches" ? (
          <MatchBrowser />
        ) : route.page === "results" ? (
          <ResultsPage />
        ) : route.page === "methodology" ? (
          <MethodologyPage section={route.section} />
        ) : (
          <HomePage />
        )}
      </main>
      {import.meta.env.DEV && mock && (
        <div className="devbadge" title="Development only: the API is simulated in the browser from the local match logs in runs/ (src/viewer/dev/mockApi.ts).">
          Mock API
        </div>
      )}
    </div>
  );
}
