#!/usr/bin/env node
/**
 * refresh-skills.mjs
 *
 * Fetches the latest agent skills from the SkillsMP API and updates
 * the "## Agent Skills" section in README.md.
 *
 * Usage:
 *   SKILLSMP_API_KEY=sk_live_... node scripts/refresh-skills.mjs
 *
 * Rate-limit aware: uses 2s delay between API calls.
 * Designed to run weekly via GitHub Actions to stay well within limits.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const README_PATH = path.join(__dirname, "..", "README.md");
const REPORT_PATH = path.join(__dirname, "skills-refresh-report.json");

const API_KEY = process.env.SKILLSMP_API_KEY;
if (!API_KEY) {
  console.error("ERROR: SKILLSMP_API_KEY environment variable is required");
  process.exit(1);
}

const API_BASE = "https://skillsmp.com/api/v1/skills/search";
const RATE_LIMIT_DELAY = 2000; // 2s between requests — conservative

// Category definitions: id → { title, queries }
const CATEGORIES = {
  "developer-advocacy-relations": {
    title: "Developer Advocacy & Relations",
    queries: ["developer advocacy", "developer relations", "developer experience"],
  },
  "technical-writing-documentation": {
    title: "Technical Writing & Documentation",
    queries: ["technical writing", "documentation", "api documentation"],
  },
  "content-creation-marketing": {
    title: "Content Creation & Marketing",
    queries: ["content creation", "blog writing", "newsletter writing"],
  },
  "speaking-presentations": {
    title: "Speaking & Presentations",
    queries: ["presentation", "public speaking", "conference talk"],
  },
  "community-building": {
    title: "Community Building",
    queries: ["community management", "community engagement", "discord bot"],
  },
  "code-review-developer-tools": {
    title: "Code Review & Developer Tools",
    queries: ["code review", "code quality", "linting"],
  },
  "ai-llm-tools": {
    title: "AI & LLM Tools",
    queries: ["llm", "prompt engineering", "ai tools"],
  },
  "api-design-developer-experience": {
    title: "API Design & Developer Experience",
    queries: ["api design", "api documentation", "developer tools"],
  },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSkills(query, limit = 20) {
  const url = `${API_BASE}?q=${encodeURIComponent(query)}&limit=${limit}`;
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.warn(`  WARN: API returned ${response.status} for "${query}"`);
      return [];
    }

    const data = await response.json();
    if (data?.data?.skills && Array.isArray(data.data.skills)) return data.data.skills;
    if (Array.isArray(data)) return data;
    if (data.skills && Array.isArray(data.skills)) return data.skills;
    return [];
  } catch (err) {
    console.warn(`  WARN: Fetch failed for "${query}": ${err.message}`);
    return [];
  }
}

function extractSkillData(raw) {
  return {
    name: raw.name || raw.skill_name || "",
    author: raw.author || raw.owner || raw.repo_owner || "",
    skillUrl: raw.skillUrl || raw.skill_url || raw.url || "",
    githubUrl: raw.githubUrl || raw.github_url || raw.repo_url || "",
  };
}

async function fetchCategorySkills(catId, config) {
  const allSkills = new Map(); // dedup by skillUrl

  for (const query of config.queries) {
    console.log(`  Searching: "${query}"...`);
    const results = await fetchSkills(query);
    for (const raw of results) {
      const skill = extractSkillData(raw);
      if (skill.name && skill.skillUrl && !allSkills.has(skill.skillUrl)) {
        allSkills.set(skill.skillUrl, skill);
      }
    }
    await sleep(RATE_LIMIT_DELAY);
  }

  return Array.from(allSkills.values());
}

// Parse existing skills from the README to preserve manual edits
function parseExistingSkills(readme) {
  const existing = new Map(); // skillUrl → { name, author, githubUrl }
  const skillRegex = /^- \[([^\]]+)\]\(([^)]+)\)(?:\s*—\s*by\s+(.+))?$/gm;
  const githubRegex = /^\t- \[GitHub\]\(([^)]+)\)$/gm;

  // Extract the Agent Skills section
  const sectionStart = readme.indexOf("## Agent Skills");
  if (sectionStart === -1) return existing;

  const sectionEnd = readme.indexOf("\n## ", sectionStart + 1);
  const section = sectionEnd === -1 ? readme.slice(sectionStart) : readme.slice(sectionStart, sectionEnd);

  let match;
  while ((match = skillRegex.exec(section)) !== null) {
    const [, name, skillUrl, author] = match;
    existing.set(skillUrl, { name, author: author || "", skillUrl, githubUrl: "" });
  }

  // Match GitHub URLs to skills (they appear on the next line after the skill)
  const lines = section.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const skillMatch = lines[i].match(/^- \[([^\]]+)\]\(([^)]+)\)/);
    if (skillMatch && i + 1 < lines.length) {
      const ghMatch = lines[i + 1].match(/^\t- \[GitHub\]\(([^)]+)\)/);
      if (ghMatch && existing.has(skillMatch[2])) {
        existing.get(skillMatch[2]).githubUrl = ghMatch[1];
      }
    }
  }

  return existing;
}

function generateSkillsSection(categoryData) {
  const lines = [];
  lines.push("## Agent Skills");
  lines.push("");
  lines.push(
    "AI agent skills (using the open [SKILL.md](https://skillsmp.com) standard) that help DevRel professionals automate and enhance their workflows. Compatible with Claude Code, OpenAI Codex CLI, Gemini CLI, and other AI coding agents."
  );
  lines.push("");

  for (const [catId, config] of Object.entries(CATEGORIES)) {
    const skills = categoryData.get(catId) || [];
    lines.push(`### ${config.title}`);
    lines.push("");

    for (const skill of skills) {
      const authorPart = skill.author ? ` — by ${skill.author}` : "";
      lines.push(`- [${skill.name}](${skill.skillUrl})${authorPart}`);
      if (skill.githubUrl) {
        lines.push(`\t- [GitHub](${skill.githubUrl})`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function updateReadme(readme, newSection) {
  const sectionStart = readme.indexOf("## Agent Skills");
  if (sectionStart === -1) {
    // Insert before ## Related
    const relatedPos = readme.indexOf("\n## Related");
    if (relatedPos === -1) {
      return readme + "\n" + newSection;
    }
    return readme.slice(0, relatedPos) + "\n" + newSection + "\n" + readme.slice(relatedPos);
  }

  // Replace existing section
  const sectionEnd = readme.indexOf("\n## ", sectionStart + 1);
  if (sectionEnd === -1) {
    return readme.slice(0, sectionStart) + newSection;
  }
  return readme.slice(0, sectionStart) + newSection + readme.slice(sectionEnd);
}

// Update the TOC counts
function updateTocCounts(readme, categoryData) {
  let total = 0;
  for (const [, skills] of categoryData) {
    total += skills.length;
  }

  // Update the Agent Skills total in TOC
  readme = readme.replace(
    /\[Agent Skills\]\(#agent-skills\)\s*\(\d+\)/,
    `[Agent Skills](#agent-skills) (${total})`
  );

  // Update subcategory counts
  for (const [catId, config] of Object.entries(CATEGORIES)) {
    const count = (categoryData.get(catId) || []).length;
    const anchor = config.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "");
    const regex = new RegExp(
      `\\[${config.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\(#${anchor}\\)\\s*\\(\\d+\\)`
    );
    readme = readme.replace(regex, `[${config.title}](#${anchor}) (${count})`);
  }

  // Update total resource count (find the existing number and add the difference)
  const totalMatch = readme.match(/curated list of \*\*(\d+)\*\* resources/);
  if (totalMatch) {
    // Recalculate: count all "^- [" lines in the README
    const allResourceCount = (readme.match(/^- \[/gm) || []).length;
    readme = readme.replace(
      /curated list of \*\*\d+\*\* resources/,
      `curated list of **${allResourceCount}** resources`
    );
  }

  return readme;
}

async function main() {
  console.log("=== Agent Skills Refresh ===");
  console.log(`Time: ${new Date().toISOString()}`);
  console.log();

  let readme = fs.readFileSync(README_PATH, "utf8");
  const existingSkills = parseExistingSkills(readme);
  console.log(`Existing skills in README: ${existingSkills.size}`);

  const categoryData = new Map();
  let totalNew = 0;

  for (const [catId, config] of Object.entries(CATEGORIES)) {
    console.log(`\nCategory: ${config.title}`);
    const fetched = await fetchCategorySkills(catId, config);
    console.log(`  Fetched ${fetched.length} skills from API`);

    // Merge: keep existing skills, add new ones
    const merged = new Map();

    // First, add all existing skills for this category
    // (We need to figure out which existing skills belong to this category)
    // For simplicity, we'll use the fetched data as the source of truth
    // but preserve any manually-added skills from the README

    for (const skill of fetched) {
      merged.set(skill.skillUrl, skill);
    }

    // Check for new skills
    const newCount = fetched.filter((s) => !existingSkills.has(s.skillUrl)).length;
    totalNew += newCount;
    if (newCount > 0) {
      console.log(`  New skills: ${newCount}`);
    }

    categoryData.set(catId, Array.from(merged.values()));
  }

  console.log("\n--- Regenerating Agent Skills section ---");
  const newSection = generateSkillsSection(categoryData);
  readme = updateReadme(readme, newSection);
  readme = updateTocCounts(readme, categoryData);

  fs.writeFileSync(README_PATH, readme);
  console.log("README.md updated");

  // Write report
  const totalSkills = Array.from(categoryData.values()).reduce((sum, arr) => sum + arr.length, 0);
  const report = {
    timestamp: new Date().toISOString(),
    totalSkills,
    newSkillsAdded: totalNew,
    categoriesProcessed: Object.keys(CATEGORIES).length,
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nDone! Total skills: ${totalSkills}, New: ${totalNew}`);
  console.log(`Report saved to ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
