# Project Configuration

{{marker}}

Generated from the PROJECT_SETUP.md questionnaire. This file is the north star
for this build — the harness and the infrastructure MCP read it to scaffold,
test, and provision. Edit answers by re-running the questionnaire.

## Your Answers

- **Project Description:** {{answers.description}}
- **Skill Level:** {{answers.skillLevel}}
- **Project Type:** {{answers.projectType}}<!-- when: answers.targetPlatform -->
- **Target Platform:** {{answers.targetPlatform}}<!-- /when -->
- **Development Language:** {{languageLabel}}
- **Virtualization Available:** {{answers.virtualization}}<!-- when: answers.hypervisorKind --> ({{answers.hypervisorKind}})<!-- /when -->
- **Development OS:** {{answers.devOs}}
- **Project Philosophy:** {{answers.philosophy}}
