// Ready-made agents to start from. A template is a description and what it
// needs, never a finished plan: using one fills in the New agent form, and
// the plan is then proposed from the user's own tools (their apps, their
// servers, their memory), so nothing of anyone else's is ever copied.

export interface AgentTemplate {
  id: string;
  name: string;
  category: "Personal" | "Work" | "Engineering" | "Research";
  /** One line for the gallery card. */
  summary: string;
  /** What the agent should do, as the user would have typed it. Theirs to edit. */
  description: string;
  web: boolean;
  sandbox: boolean;
  /** Apps to connect, by the provider's slug, with the name to show. */
  apps: { slug: string; name: string }[];
  /** Set when it needs a memory: what the memory is for. */
  memory?: string;
  /** Set when it needs an MCP server for the user's own API: what that API should offer. */
  ownApi?: string;
  /** Suits running by itself at set times (set up on the agent's Schedule tab once it's created). */
  schedulable?: boolean;
}

export const TEMPLATES: AgentTemplate[] = [
  {
    id: "research-brief",
    name: "Research brief",
    category: "Research",
    summary: "Researches a topic on the web and writes a short, sourced brief.",
    description:
      "When I give you a topic or a question, research it on the web using several independent sources. Write a brief of no more than one page: the answer first, then the key facts, then what is uncertain or disputed. Link every claim to where you found it, and say so plainly when sources disagree or you couldn't find something.",
    web: true,
    sandbox: false,
    apps: [],
  },
  {
    id: "inbox-triage",
    name: "Inbox triage",
    category: "Personal",
    summary: "Sorts unread email by urgency and drafts replies for you to approve.",
    description:
      "Go through my unread email. Group it into: needs a reply today, can wait, and no action needed, with one line on each message. For the ones that need a reply, write a draft in my tone and save it as a draft. Never send an email, archive or delete anything without asking me first.",
    web: false,
    sandbox: false,
    schedulable: true,
    apps: [{ slug: "gmail", name: "Gmail" }],
  },
  {
    id: "job-applications",
    name: "Job application assistant",
    category: "Personal",
    summary: "Finds roles that fit you, tailors each application and tracks what was sent.",
    description:
      "Help me apply for jobs. Start by reading my memory for my experience, skills and the kind of role and companies I want. Search the web for open roles that fit and show me a shortlist with why each one matches. For a role I pick, write a tailored cover note and the email to send. Ask me before sending anything. After each application, save to memory the company, the role, the date and what was sent, and update it when I tell you how it went.",
    web: true,
    sandbox: false,
    apps: [{ slug: "gmail", name: "Gmail" }],
    memory: "Your experience, skills and the roles you want. The agent adds each application to it.",
  },
  {
    id: "meeting-prep",
    name: "Meeting prep",
    category: "Work",
    summary: "Reads your calendar and prepares a short brief for each meeting.",
    description:
      "When I ask, look at my meetings for the day I name (today if I don't say). For each one, write a short brief: who is attending and what they do, what the meeting is about, anything relevant from recent email with those people, and two or three questions worth asking. Look attendees and their companies up on the web when they're from outside my organisation. Don't create, change or cancel any event.",
    web: true,
    sandbox: false,
    schedulable: true,
    apps: [
      { slug: "googlecalendar", name: "Google Calendar" },
      { slug: "gmail", name: "Gmail" },
    ],
  },
  {
    id: "support-triage",
    name: "Support triage",
    category: "Work",
    summary: "Looks a customer up in your own system and drafts the reply.",
    description:
      "When I paste in a support request, work out what the customer is asking for. Look up their account and recent orders or activity using my API, and draft a reply that answers them using what you found. If it needs a refund, an account change or anything else that alters data, say what you would do and ask me before doing it. If you can't find the customer, say so instead of guessing.",
    web: false,
    sandbox: false,
    apps: [],
    ownApi: "An MCP server for your product's API, with tools to look up customers and their orders or activity.",
  },
  {
    id: "issue-triage",
    name: "GitHub issue triage",
    category: "Engineering",
    summary: "Reviews new issues, spots duplicates and suggests labels and next steps.",
    description:
      "Look at the open issues in the repository I name that have no labels or no reply yet. For each one, summarise it in a line, point out likely duplicates with links, suggest labels and a priority, and say what information is missing. Ask me before adding labels, commenting on or closing any issue.",
    web: false,
    sandbox: false,
    apps: [{ slug: "github", name: "GitHub" }],
  },
  {
    id: "channel-digest",
    name: "Slack digest",
    category: "Work",
    summary: "Summarises what happened in the channels you care about.",
    description:
      "When I ask, read the messages since yesterday (or the period I name) in the Slack channels I list. Give me a digest for each channel: decisions made, questions still open, anything that mentions me or needs my reply, and links to the threads. Keep it short. Don't post, react or reply in Slack unless I ask you to, and then ask me to confirm the message first.",
    web: false,
    sandbox: false,
    schedulable: true,
    apps: [{ slug: "slack", name: "Slack" }],
  },
  {
    id: "lead-research",
    name: "Lead research",
    category: "Work",
    summary: "Researches companies on a list and fills in what you need to know.",
    description:
      "I keep a list of companies in a Google Sheet. For each row that hasn't been researched, look the company up on the web and find what it does, its size, where it's based, any recent news, and who the likely contact is for what I sell. Show me what you found, with sources, and ask before writing it into the sheet. Leave a cell empty when you can't find something reliable.",
    web: true,
    sandbox: false,
    apps: [{ slug: "googlesheets", name: "Google Sheets" }],
  },
  {
    id: "second-brain",
    name: "Second brain",
    category: "Personal",
    summary: "Remembers what you tell it and answers from what it knows about you.",
    description:
      "You are my notebook. When I tell you something worth keeping (a decision, a fact, an idea, a preference, a plan), save it to memory under the topic it fits, creating a topic when none does, and update an existing note instead of adding a second one. When I ask a question, search memory first and answer from it, saying which note the answer came from. Tell me when you don't have anything on it.",
    web: false,
    sandbox: false,
    apps: [],
    memory: "Starts empty, or with whatever you'd like it to know. It grows as you talk to the agent.",
  },
  {
    id: "data-analyst",
    name: "Data analyst",
    category: "Research",
    summary: "Analyses a file or dataset you give it and explains what it found.",
    description:
      "When I give you data (pasted in, or a link to a file), load it in your sandbox and analyse it. Start by telling me what's in it and anything that looks wrong, such as missing values or duplicates. Then answer my question with the numbers that support it, and show the calculation you ran. Say how confident you are and what the data can't tell us.",
    web: true,
    sandbox: true,
    apps: [],
  },
];

export const CATEGORIES = ["Personal", "Work", "Engineering", "Research"] as const;

export function findTemplate(id: string | null): AgentTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/** What a template needs before it can run, as short labels ("Gmail", "A memory"). Empty when it needs nothing. */
export function templateNeeds(template: AgentTemplate): string[] {
  return [...template.apps.map((a) => a.name), ...(template.memory ? ["A memory"] : []), ...(template.ownApi ? ["Your own API"] : [])];
}
