import { Route, Switch, Router, Redirect } from "wouter";
import { BoardPage } from "./BoardPage";
import { BoardMissionDetail } from "./BoardMissionDetail";
import { BoardLayout } from "./BoardLayout";
import { HomePage } from "./HomePage";
import { EvalDashboard } from "./eval/EvalDashboard";
import { EvalCases } from "./eval/EvalCases";
import { EvalCaseDetail } from "./eval/EvalCaseDetail";
import { EvalRun } from "./eval/EvalRun";
import { EvalRunDetail } from "./eval/EvalRunDetail";

function NotFound() {
  return (
    <BoardLayout title="Mission Board">
      <div className="flex h-[60vh] items-center justify-center">
        <div className="text-center text-muted-foreground">
          <div className="mb-3 text-4xl opacity-30">404</div>
          <div className="text-sm">Use /mission/:project to view a project board</div>
        </div>
      </div>
    </BoardLayout>
  );
}

export function BoardApp() {
  return (
    <Router>
      <Switch>
        <Route path="/" component={HomePage} />
        <Route path="/eval" component={EvalDashboard} />
        <Route path="/eval/cases/:id" component={EvalCaseDetail} />
        <Route path="/eval/cases" component={EvalCases} />
        <Route path="/eval/run/:runId" component={EvalRunDetail} />
        <Route path="/eval/run" component={EvalRun} />
        <Route path="/mission/:slug/issue/:id" component={BoardMissionDetail} />
        <Route path="/mission/:slug" component={BoardPage} />
        <Route component={NotFound} />
      </Switch>
    </Router>
  );
}
