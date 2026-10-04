import { agentOS, setup } from "@rivet-dev/agentos";
import browserbase from "@agentos-software/browserbase";
import common from "@agentos-software/common";
import curl from "@agentos-software/curl";
import git from "@agentos-software/git";
import jq from "@agentos-software/jq";
import pi from "@agentos-software/pi";

const vm = agentOS({
	software: [pi, common, git, curl, jq, browserbase],
	permissions: { network: "allow" },
});

export const registry = setup({ use: { vm } });
registry.start();
