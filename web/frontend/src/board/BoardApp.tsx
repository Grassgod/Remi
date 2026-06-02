import { Route, Switch, Router } from "wouter";
import { AuthGate } from "../components/AuthGate";
import { BoardLoginPrompt } from "./BoardLoginPrompt";
import { BoardPage } from "./BoardPage";
import { BoardMissionDetail } from "./BoardMissionDetail";
import { BoardLayout } from "./BoardLayout";
import { HomePage } from "./HomePage";
import { AllMissionsBoardPage } from "./AllMissionsBoardPage";

function NotFound() {
  return (
    <BoardLayout title="Mission Board">
      <div className="flex h-[60vh] items-center justify-center">
        <div className="text-center text-muted-foreground">
          <div className="mb-3 text-4xl opacity-30">404</div>
          <div className="text-sm">Use /board/:project to view a project board</div>
        </div>
      </div>
    </BoardLayout>
  );
}

export function BoardApp() {
  return (
    <Router>
      <AuthGate
        isPublic={(p) => p === "/"}
        renderUnauthenticated={(path) => <BoardLoginPrompt next={path} />}
      >
        <Switch>
          <Route path="/" component={HomePage} />
          <Route path="/board" component={AllMissionsBoardPage} />
          <Route path="/board/:slug/issue/:id" component={BoardMissionDetail} />
          <Route path="/board/:slug" component={BoardPage} />
          <Route component={NotFound} />
        </Switch>
      </AuthGate>
    </Router>
  );
}
