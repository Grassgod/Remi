import { Route, Switch, Router as WouterRouter } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { Dashboard } from "./pages/Dashboard";
import { Memory } from "./pages/Memory";
import { MemoryEntity } from "./pages/MemoryEntity";
import { MemoryDaily } from "./pages/MemoryDaily";
import { Sessions } from "./pages/Sessions";
import { Auth } from "./pages/Auth";
import { Config } from "./pages/Config";
import { Projects } from "./pages/Projects";
import { Analytics } from "./pages/Analytics";
import { Layout } from "./components/Layout";

function Placeholder({ title }: { title: string }) {
  return (
    <Layout title={title} subtitle="Coming Soon">
      <div className="flex h-[60vh] items-center justify-center">
        <div className="text-center text-muted-foreground">
          <div className="mb-3 text-4xl opacity-30">--</div>
          <div className="text-sm font-semibold uppercase tracking-widest">
            {title} Module
          </div>
          <div className="mt-2 font-mono text-[10px] tracking-wide">
            Phase 2 Implementation
          </div>
        </div>
      </div>
    </Layout>
  );
}

export function App() {
  return (
    <WouterRouter hook={useHashLocation}>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/memory" component={Memory} />
        <Route path="/memory/entity/:type/:name" component={MemoryEntity} />
        <Route path="/memory/daily/:date" component={MemoryDaily} />
        <Route path="/sessions" component={Sessions} />
        <Route path="/auth" component={Auth} />
        <Route path="/config" component={Config} />
        <Route path="/projects" component={Projects} />
        <Route path="/analytics" component={Analytics} />
        <Route path="/scheduler">{() => <Placeholder title="Scheduler" />}</Route>
        <Route path="/tools">{() => <Placeholder title="Tools" />}</Route>
        <Route path="/monitor">{() => <Placeholder title="Monitor" />}</Route>
        <Route>{() => <Placeholder title="Not Found" />}</Route>
      </Switch>
    </WouterRouter>
  );
}
