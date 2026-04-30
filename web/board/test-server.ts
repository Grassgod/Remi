import { startBoardServer } from "./server.ts";
import { MissionStore } from "../../src/mission/store.ts";
import { loadConfig } from "../../src/config.ts";

const config = loadConfig();
startBoardServer({ config, missionStore: new MissionStore(), authToken: "" });
