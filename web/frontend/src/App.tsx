import { Route, Switch, Router as WouterRouter } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { Dashboard } from "./pages/Dashboard";
import { Conversations } from "./pages/Conversations";
import { Missions } from "./pages/Missions";
import { MissionDetail } from "./pages/MissionDetail";
import { Memory } from "./pages/Memory";
import { MemoryEntity } from "./pages/MemoryEntity";
import { MemoryDaily } from "./pages/MemoryDaily";
import { Wiki } from "./pages/Wiki";
import { Analytics } from "./pages/Analytics";
import { Traces } from "./pages/Traces";
import { Logs } from "./pages/Logs";
import { Scheduler } from "./pages/Scheduler";
import { Sessions } from "./pages/Sessions";
import { Projects } from "./pages/Projects";
import { BotMenu } from "./pages/BotMenu";
import { Layout } from "./components/Layout";

function NotFound() {
  return (
    <Layout title="Not Found">
      <div className="flex h-[60vh] items-center justify-center">
        <div className="text-center text-muted-foreground">
          <div className="mb-3 text-4xl opacity-30">404</div>
          <div className="text-sm">Page not found</div>
        </div>
      </div>
    </Layout>
  );
}

export function App() {
  return (
    <WouterRouter hook={useHashLocation}>
      <Switch>
        {/* Overview */}
        <Route path="/" component={Dashboard} />

        {/* Workspace */}
        <Route path="/conversations" component={Conversations} />
        <Route path="/missions/:id" component={MissionDetail} />
        <Route path="/missions" component={Missions} />
        <Route path="/memory" component={Memory} />
        <Route path="/memory/entity/:type/:name" component={MemoryEntity} />
        <Route path="/memory/daily/:date" component={MemoryDaily} />
        <Route path="/wiki" component={Wiki} />

        {/* Observability */}
        <Route path="/analytics" component={Analytics} />
        <Route path="/traces" component={Traces} />
        <Route path="/logs" component={Logs} />
        <Route path="/scheduler" component={Scheduler} />

        {/* System */}
        <Route path="/sessions" component={Sessions} />
        <Route path="/projects" component={Projects} />
        <Route path="/bot-menu" component={BotMenu} />

        {/* Redirects for old routes */}
        <Route path="/auth">{() => { window.location.hash = "#/"; return null; }}</Route>
        <Route path="/monitor">{() => { window.location.hash = "#/"; return null; }}</Route>
        <Route path="/database">{() => { window.location.hash = "#/"; return null; }}</Route>
        <Route path="/config">{() => { window.location.hash = "#/"; return null; }}</Route>
        <Route path="/symlinks">{() => { window.location.hash = "#/"; return null; }}</Route>

        <Route component={NotFound} />
      </Switch>
    </WouterRouter>
  );
}
