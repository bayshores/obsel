workspace "obsel" "Runtime architecture for obsel's agent-work freshness and erasure coverage system." {

    model {
        operator = person "Operator" "Runs the local demo, watches the lineage board, investigates stale work, and reviews erasure coverage."

        externalAgent = softwareSystem "MCP-capable AI agent" "A Codex, Claude, or other agent that joins a swarm at runtime and reports the work it reads and writes." {
            tags "Agent"
        }

        agentCli = softwareSystem "Agent CLI" "A locally authenticated Codex CLI or Claude Code process that performs the demo agents' actual work." {
            tags "Agent"
        }

        datahub = softwareSystem "DataHub" "The authoritative catalog, lineage graph, task state store, change ledger, erasure ledger, and human-visible stale tags." {
            tags "SystemOfRecord"
        }

        obsel = softwareSystem "obsel" "Detects when completed agent work is based on changed data and accounts for erasure coverage without reading warehouse data." {
            tags "obsel"

            dashboard = container "obsel dashboard" "Shows the live swarm, lineage, stale causes, history, and erasure coverage. It renders DataHub-backed snapshots and makes no freshness decisions." "Next.js, React, React Flow" {
                tags "UI"
            }

            server = container "obsel server" "Bearer-token-gated HTTP API plus deterministic freshness and erasure coordinators. It compares fingerprints, walks lineage, records decisions, and never calls a model." "Next.js route handlers, TypeScript" {
                tags "Core"
            }

            agentBridge = container "agent integration" "Exposes obsel's MCP tools, runs the local demo workers, fingerprints table contents, and translates agent lifecycle events into HTTP calls." "Python, FastMCP" {
                tags "Integration"
            }

            demoData = container "demo data workspace" "Local JSON inputs, outputs, and recoverable worker run artifacts used only by the demo. This is not obsel's source of truth." "Local filesystem" {
                tags "Data"
            }
        }

        operator -> obsel "Uses the live board and starts local workflows" "Browser / HTTPS" {
            tags "UserFlow"
        }
        externalAgent -> obsel "Checks freshness and reports task lifecycle" "MCP / stdio" {
            tags "AgentFlow"
        }
        obsel -> datahub "Uses as the authoritative graph and state store" "GMS HTTP + DataHub MCP" {
            tags "CatalogFlow"
        }
        obsel -> agentCli "Runs real demo agent sessions" "Local process" {
            tags "AgentFlow"
        }

        operator -> dashboard "Views state, starts demos, and submits erasure requests or attestations" "Browser / HTTPS" {
            tags "UserFlow"
        }
        dashboard -> server "Polls snapshots and sends authenticated commands" "JSON / HTTP" {
            tags "UserFlow"
        }
        externalAgent -> agentBridge "Checks freshness; registers, starts, completes, or abandons work" "MCP / stdio" {
            tags "AgentFlow"
        }
        server -> agentBridge "Starts allow-listed demo and scale steps" "Local child process" {
            tags "AgentFlow"
        }
        agentBridge -> server "Reports task lifecycle, observations, fingerprints, and attestations" "JSON / HTTP" {
            tags "AgentFlow"
        }
        agentBridge -> agentCli "Runs the task's actual reasoning and tool use" "codex exec / claude -p" {
            tags "AgentFlow"
        }
        agentCli -> demoData "Reads inputs and writes produced tables" "Local files" {
            tags "DataFlow"
        }
        agentBridge -> demoData "Canonicalizes and fingerprints tables; keeps recoverable demo run state" "Local files" {
            tags "DataFlow"
        }
        server -> datahub "Reads lineage and snapshots; writes DataJobs, properties, ledgers, and stale tags" "GMS HTTP + MCP / stdio" {
            tags "CatalogFlow"
        }
        operator -> server "Reports observed dataset fingerprints and supplies signed erasure attestations" "JSON / HTTPS" {
            tags "TrustFlow"
        }
    }

    views {
        systemContext obsel "SystemContext" "Where obsel sits in the agent and data-governance landscape." {
            include *
            autoLayout tb 320 260
        }

        container obsel "Containers" "Runtime boundaries and the main information flows through obsel." {
            include *
            autoLayout tb 300 240
        }

        styles {
            element "Element" {
                background #131118
                color #F5EEF0
                stroke #A64D79
                strokeWidth 1
                fontSize 18
                shape Box
                metadata true
                description true
            }
            element "Person" {
                background #131118
                color #F5EEF0
                stroke #E85D92
                shape Box
            }
            element "Software System" {
                background #131118
                color #F5EEF0
                stroke #A64D79
            }
            element "Container" {
                background #1A171F
                color #F5EEF0
                stroke #A64D79
            }
            element "obsel" {
                background #131118
                color #F5EEF0
                stroke #E85D92
            }
            element "UI" {
                background #1A171F
                color #F5EEF0
                stroke #E85D92
                shape Box
            }
            element "Core" {
                background #1A171F
                color #F5EEF0
                stroke #F7A8C4
                shape Box
            }
            element "Integration" {
                background #131118
                color #F5EEF0
                stroke #7FD7EF
                shape Box
            }
            element "SystemOfRecord" {
                background #111916
                color #F5EEF0
                stroke #78D7A3
                shape Box
            }
            element "Data" {
                background #1C160C
                color #F5EEF0
                stroke #FFB020
                shape Box
            }
            element "Agent" {
                background #11181C
                color #F5EEF0
                stroke #7FD7EF
                shape Box
            }
            relationship "Relationship" {
                color #A64D79
                thickness 1
                fontSize 14
                routing Orthogonal
                dashed false
            }
            relationship "UserFlow" {
                color #E85D92
                thickness 2
                dashed false
            }
            relationship "CatalogFlow" {
                color #78D7A3
                thickness 2
                dashed false
            }
            relationship "AgentFlow" {
                color #7FD7EF
                thickness 2
                dashed false
            }
            relationship "DataFlow" {
                color #FFB020
                thickness 2
                dashed false
            }
            relationship "TrustFlow" {
                color #F7A8C4
                thickness 2
                dashed true
            }
        }

        theme default
    }

    configuration {
        scope softwaresystem
    }
}
