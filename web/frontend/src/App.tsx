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
import { Skills } from "./pages/Skills";
import { Mcp } from "./pages/Mcp";
import { Analytics } from "./pages/Analytics";
import { Traces } from "./pages/Traces";
import { Logs } from "./pages/Logs";
import { Scheduler } from "./pages/Scheduler";
import { Agents } from "./pages/Agents";
import { Projects } from "./pages/Projects";
import { ProjectConfig } from "./pages/ProjectConfig";
import { BotMenu } from "./pages/BotMenu";
import { Config } from "./pages/Config";
import { Auth } from "./pages/Auth";
import { Database } from "./pages/Database";
import { Symlinks } from "./pages/Symlinks";
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
        <Route path="/skills" component={Skills} />
        <Route path="/mcp" component={Mcp} />

        {/* Observability */}
        <Route path="/analytics" component={Analytics} />
        <Route path="/traces" component={Traces} />
        <Route path="/logs" component={Logs} />
        <Route path="/scheduler" component={Scheduler} />

        {/* System */}
        <Route path="/agents" component={Agents} />
        <Route path="/projects/:id/config" component={ProjectConfig} />
        <Route path="/projects" component={Projects} />
        <Route path="/bot-menu" component={BotMenu} />

        <Route path="/auth" component={Auth} />
        <Route path="/database" component={Database} />

        {/* Redirects for old routes */}
        <Route path="/sessions">{() => { window.location.hash = "#/"; return null; }}</Route>
        <Route path="/monitor">{() => { window.location.hash = "#/"; return null; }}</Route>
        <Route path="/config" component={Config} />
        <Route path="/symlinks" component={Symlinks} />

        <Route component={NotFound} />
      </Switch>
    </WouterRouter>
  );
}
