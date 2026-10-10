import { useEffect } from "react";
import { MatchBrowser } from "./browser/MatchBrowser.tsx";
import { MatchView } from "./match/MatchView.tsx";
import { ResultsPage } from "./results/ResultsPage.tsx";
import { useRoute } from "./lib/router.ts";

export function App() {
  const route = useRoute();
  const key = route.page === "match" ? `m/${route.runId}/${route.matchId}` : route.page === "results" ? `r/${route.runId}` : "b";

  useEffect(() => {
    document.title =
      route.page === "match" ? `${route.matchId} · Decision Arena` : route.page === "results" ? `Results${route.runId ? ` · ${route.runId}` : ""} · Decision Arena` : "Decision Arena";
    if (route.page !== "match") window.scrollTo({ top: 0 });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`app app--${route.page}`}>
      <header className="topnav">
        <a className="brand" href="#/" aria-label="Decision Arena home">
          <svg className="brand__mark" viewBox="0 0 32 32" aria-hidden>
            <circle cx="16" cy="16" r="9" fill="none" stroke="#38d9f5" strokeWidth="2.4" />
            <path d="M16 2.5v7M16 22.5v7M2.5 16h7M22.5 16h7" stroke="#ff9d3c" strokeWidth="2.4" strokeLinecap="round" />
            <circle cx="16" cy="16" r="2.2" fill="#e8eef6" />
          </svg>
          <span className="brand__word">Decision<b>Arena</b></span>
        </a>
        <nav className="topnav__links">
          <a href="#/" className={route.page === "browser" || route.page === "match" ? "is-on" : ""}>Matches</a>
          <a href="#/results" className={route.page === "results" ? "is-on" : ""}>Results</a>
        </nav>
        <div className="topnav__right">
          <span className="topnav__lineup"><i className="sw sw--jev" />Jev 1.13 <span>vs</span> <i className="sw sw--ms" />Microsoft Decision 1</span>
        </div>
      </header>
      <main className="page" key={key}>
        {route.page === "match" ? (
          <MatchView runId={route.runId} matchId={route.matchId} t={route.t} />
        ) : route.page === "results" ? (
          <ResultsPage runId={route.runId} />
        ) : (
          <MatchBrowser />
        )}
      </main>
    </div>
  );
}
