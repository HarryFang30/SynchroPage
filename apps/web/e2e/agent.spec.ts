import { test, expect } from "@playwright/test";
import { activateAgent, resetStorage, mockApi } from "./helpers";

test.describe("Agent Panel", () => {
  test.beforeEach(async ({ page }) => {
    await resetStorage(page);
    // Mock all API calls so the agent doesn't need a real backend
    await mockApi(page, {
      "/api/agent/chat": { content: "Mock assistant reply from e2e." },
    });
  });

  test("agent panel is present", async ({ page }) => {
    await activateAgent(page);
    await expect(page.locator(".agent-panel")).toBeVisible();
  });

  test("agent toolbar shows model label", async ({ page }) => {
    await activateAgent(page);
    const toolbar = page.locator(".agent-toolbar");
    await expect(toolbar).toBeVisible();
    await expect(toolbar.locator(".toolbar-title")).toBeVisible();
    await expect(toolbar.locator(".agent-model")).toHaveText(/OAuth|Local/);
  });

  test("composer input accepts text", async ({ page }) => {
    const composer = await activateAgent(page);
    await composer.click();
    await composer.fill("Hello, this is a test message");
    await expect(composer).toHaveValue("Hello, this is a test message");
  });

  test("composer send button exists", async ({ page }) => {
    await activateAgent(page);
    await expect(page.locator(".composer-send")).toBeVisible();
  });

  test("agent welcome message is shown when empty", async ({ page }) => {
    await activateAgent(page);
    await expect(page.locator(".aui-welcome")).toBeVisible();
    await expect(page.locator(".prompt-suggestions button")).toHaveCount(4);
  });

  test("challenge panel controls stay inside a narrow agent panel", async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 720 });
    await activateAgent(page);
    const panel = page.locator(".challenge-panel");
    await expect(panel).toBeVisible();

    const overflow = await panel.evaluate((element) => {
      const panelRect = element.getBoundingClientRect();
      const descendants = Array.from(element.querySelectorAll("*"));
      let minLeft = panelRect.left;
      let maxRight = panelRect.right;
      for (const descendant of descendants) {
        const rect = descendant.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        minLeft = Math.min(minLeft, rect.left);
        maxRight = Math.max(maxRight, rect.right);
      }
      return {
        left: panelRect.left - minLeft,
        right: maxRight - panelRect.right,
      };
    });

    expect(overflow.left).toBeLessThanOrEqual(1);
    expect(overflow.right).toBeLessThanOrEqual(1);
  });

  test("challenge panel sends the quiz v2 coach prompt and runs the overlay", async ({ page }) => {
    await page.unroute("**/api/**");
    let requestPayload: {
      input?: string;
      messages?: Array<{ content?: string }>;
      modelProviderId?: string;
      model?: string;
      reasoningEffort?: string;
    } | null = null;
    const challengeContent = String.raw`{
      "type": "synchropage.challenge_quiz.v2",
      "title": "Attention Mechanism Quiz",
      "set_goal": "分清动态加权与硬选择",
      "document_id": "doc-e2e",
      "skills": [
        {"id": "attention_core", "label": "注意力核心机制"},
        {"id": "scaled_dot_product", "label": "缩放点积打分"}
      ],
      "questions": [
        {
          "id": "q1",
          "skill_id": "attention_core",
          "knowledge_type": "concept",
          "bloom": "analyze",
          "difficulty": 2,
          "stem": "什么是注意力机制的核心思想？",
          "options": [
            {"id": "A", "text": "将所有输入序列无差别地压缩成一个固定长度向量。", "correct": false, "misconception": "把注意力当成一次性压缩。", "diagnosis": "选 A 通常是因为把编码器末状态当成了全部信息。", "fix": "注意力是逐位置加权，不是一次压缩。"},
            {"id": "B", "text": "随机丢弃一部分神经元以防止过拟合。", "correct": false, "misconception": "把 dropout 误当成注意力。", "diagnosis": "选 B 通常是因为把正则化手段和信息选择混在一起。", "fix": "dropout 改的是训练噪声，不是权重分配。"},
            {"id": "C", "text": "根据当前任务动态分配不同输入位置的权重。", "correct": true, "diagnosis": "对，关键线索是动态分配权重。"},
            {"id": "D", "text": "通过固定窗口卷积提取局部空间特征。", "correct": false, "misconception": "把卷积的局部感受野当成注意力。", "diagnosis": "选 D 通常是因为忽略了权重要依赖查询。", "fix": "卷积核固定，注意力权重随输入变化。"}
          ],
          "correct_option_id": "C",
          "hint": "先看这一页里权重到底由什么决定。",
          "explanation": {
            "why_correct": "注意力根据查询和上下文决定关注哪些输入。",
            "core_idea": "权重由相关性决定，而不是位置固定。"
          },
          "exam_relevance": {
            "how_tested": "考试常给一组权重，问模型此刻关注哪个 token。",
            "typical_trap": "把 softmax 权重理解成只能选一个 token。",
            "weight": "high"
          },
          "evidence": {"page": 2, "anchor": "图 1", "quote": "动态加权"},
          "follow_up": "如果所有位置权重都相同，还算有效注意力吗？",
          "bridge": "先说清 softmax 输出的是一组和为 1 的权重。"
        },
        {
          "id": "q2",
          "skill_id": "scaled_dot_product",
          "knowledge_type": "formula",
          "bloom": "apply",
          "difficulty": 4,
          "stem": "在 \vec{q}\cdot\vec{k} 的打分里，哪句话最准确？",
          "options": [
            {"id": "A", "text": "分数越大，softmax 后该位置通常权重越高。", "correct": true, "diagnosis": "对，点积先打相关性分，再归一化成权重。"},
            {"id": "B", "text": "\vec{q} 与 \vec{k} 必须完全相同才有注意力。", "correct": false, "misconception": "把相关性打分当成硬匹配。", "diagnosis": "选 B 通常是因为忽略了点积是连续值。", "fix": "点积衡量方向一致程度，不是相等判定。"},
            {"id": "C", "text": "\frac{1}{\sqrt{d_k}} 会删除无关 token。", "correct": false, "misconception": "把缩放项当成筛选器。", "diagnosis": "选 C 通常是因为把量级控制误当成硬删除。", "fix": "缩放只压 logits 量级。"}
          ],
          "correct_option_id": "A",
          "hint": "先看打分之后还有哪一步。",
          "explanation": {
            "why_correct": "缩放点积注意力用 \frac{\vec{q}\cdot\vec{k}}{\sqrt{d_k}} 作为 logits，再经 softmax 得到权重。",
            "core_idea": "打分、归一化、加权求和是三个分开的阶段。"
          },
          "exam_relevance": {
            "how_tested": "考试常让你比较两个 token 的未归一化打分。",
            "typical_trap": "忽略缩放项的适用原因。",
            "weight": "medium"
          },
          "evidence": {"page": 2, "anchor": "式 (3)", "quote": "缩放点积"},
          "follow_up": "如果不除以 \sqrt{d_k}，大维度下 softmax 会有什么风险？",
          "bridge": "先确认 softmax 是单调的。",
          "retry_variant": {
            "stem": "同一组打分里，把某个 logit 调大会发生什么？",
            "options": [
              {"id": "A", "text": "该位置的注意力权重上升。", "correct": true},
              {"id": "B", "text": "所有位置的权重保持不变。", "correct": false}
            ],
            "correct_option_id": "A"
          }
        }
      ]
    }`;
    await page.route("**/api/**", async (route) => {
      const url = route.request().url();
      if (url.includes("/api/agent/chat")) {
        requestPayload = JSON.parse(route.request().postData() || "{}") as typeof requestPayload;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            content: challengeContent,
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await activateAgent(page);
    await expect(page.locator(".challenge-panel")).toBeVisible();
    // The overlay must not exist before a quiz message does.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.locator(".challenge-count-option").filter({ hasText: "5" }).click();
    await page.locator(".challenge-start").click();

    await expect(page.locator(".user-message")).toContainText(/Challenge/i);

    // The overlay opens itself once the quiz message completes.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog).toContainText("分清动态加权与硬选择");
    await expect(dialog.locator(".quiz-progress-count")).toHaveText("1 / 2");
    await expect(dialog.locator(".quiz-option")).toHaveCount(4);
    await expect(dialog).toContainText("注意力核心机制");

    // A wrong first pick diagnoses the choice, reveals the hint and leaves a second attempt.
    await dialog.locator(".quiz-option").filter({ hasText: "随机丢弃" }).click();
    await expect(dialog.locator(".quiz-nudge")).toContainText("把正则化手段和信息选择混在一起");
    await expect(dialog.locator(".quiz-hint-text")).toContainText("权重到底由什么决定");
    await expect(dialog.locator(".quiz-feedback")).toHaveCount(0);
    await expect(dialog.locator(".quiz-option").filter({ hasText: "动态分配" })).toBeEnabled();

    // The second pick locks the question and shows the evidence-based explanation.
    await dialog.locator(".quiz-option").filter({ hasText: "动态分配" }).click();
    await expect(dialog.locator(".quiz-feedback")).toBeVisible();
    await expect(dialog.locator(".quiz-option.correct")).toContainText("动态分配");
    await expect(dialog.locator(".quiz-option.incorrect")).toContainText("随机丢弃");
    await expect(dialog.locator(".quiz-feedback")).toContainText("正确选项：C");
    await expect(dialog.locator(".quiz-feedback")).toContainText("权重由相关性决定");
    await expect(dialog.locator(".quiz-feedback")).toContainText("追问 AI");

    // "考试怎么考" stays collapsed until asked for.
    await expect(dialog).not.toContainText("考试常给一组权重");
    await dialog.locator(".quiz-exam-toggle").click();
    await expect(dialog.locator(".quiz-exam-body")).toContainText("考试常给一组权重");

    await dialog.locator(".quiz-next").click();
    await expect(dialog.locator(".quiz-progress-count")).toHaveText("2 / 2");
    await expect(dialog).toContainText("哪句话最准确");
    await expect(dialog.locator(".quiz-option")).toHaveCount(3);

    await dialog.locator(".quiz-option").filter({ hasText: "softmax 后该位置" }).click();
    await expect(dialog.locator(".quiz-option.correct")).toContainText("softmax 后该位置");
    await expect(dialog.locator(".quiz-next")).toContainText("看总结");
    await dialog.locator(".quiz-next").click();

    // Summary: local scoring, per-skill status, missed list and the retry queue.
    await expect(dialog.locator(".quiz-summary-score")).toContainText("1 / 2 首答正确");
    await expect(dialog.locator(".quiz-skill-list")).toContainText("注意力核心机制");
    await expect(dialog.locator(".quiz-skill-status.weak")).toHaveCount(1);
    await expect(dialog.locator(".quiz-skill-status.strong")).toHaveCount(1);
    await expect(dialog.locator(".quiz-missed-list")).toContainText("把 dropout 误当成注意力");
    await expect(dialog.locator(".quiz-retry-start")).toContainText("重做错题 (1)");

    // Esc closes the overlay; the in-thread card reopens it on the summary.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const threadCard = page.locator(".quiz-thread-card");
    await expect(threadCard).toBeVisible();
    await expect(threadCard).toContainText("Attention Mechanism Quiz");
    await expect(threadCard.locator(".quiz-thread-score")).toContainText("1 / 2 首答正确");
    await threadCard.locator(".quiz-thread-open").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").locator(".quiz-retry-start")).toContainText("重做错题 (1)");

    // The retry queue clears once the missed question is answered correctly.
    await dialog.locator(".quiz-retry-start").click();
    await expect(dialog.locator(".quiz-retry-heading")).toContainText("错题重做");
    await expect(dialog).toContainText("什么是注意力机制的核心思想");
    await dialog.locator(".quiz-option").filter({ hasText: "动态分配" }).click();
    await expect(dialog.locator(".quiz-feedback")).toContainText("判断正确");
    await dialog.locator(".quiz-next").click();
    await expect(dialog.locator(".quiz-retry-cleared")).toContainText("本轮错题已清零");

    // The prompt carries the v2 contract and the challenge markers the coach relies on.
    await expect.poll(() => requestPayload?.input || "").toContain("你是我的理工科 PPT 挑战教练");
    await expect.poll(() => requestPayload?.input || "").toContain("当前挑战模式");
    await expect.poll(() => requestPayload?.input || "").toContain("当前挑战数量：5");
    await expect.poll(() => requestPayload?.input || "").toContain("questions 数组");
    await expect.poll(() => requestPayload?.input || "").toContain("synchropage.challenge_quiz.v2");
    await expect.poll(() => requestPayload?.input || "").toContain("exam_relevance");
    await expect.poll(() => requestPayload?.input || "").toContain("misconception");
    await expect.poll(() => requestPayload?.input || "").toContain("retry_variant");
    await expect.poll(() => requestPayload?.input || "").toContain("本页讲解已识别的易卡点");
    await expect.poll(() => requestPayload?.input || "").toContain("我的历史薄弱点");
    await expect.poll(() => requestPayload?.modelProviderId || "").toBe("codex_oauth");
    await expect.poll(() => requestPayload?.model || "").toBe("gpt-5.5");
    await expect.poll(() => requestPayload?.reasoningEffort || "").toBe("xhigh");
    await expect.poll(() => requestPayload?.messages?.at(-1)?.content || "").toContain("Challenge");
  });

  test("quiz overlay still renders a legacy v1 quiz payload", async ({ page }) => {
    await page.unroute("**/api/**");
    const legacyContent = String.raw`{
      "type": "synchropage.challenge_quiz.v1",
      "title": "Legacy Quiz",
      "question_count": 1,
      "questions": [
        {
          "knowledge_type": "concept",
          "challenge_type": "概念边界题",
          "question": "旧格式题干还能渲染吗？",
          "options": [
            {"id": "A", "text": "可以，映射到新的 overlay。"},
            {"id": "B", "text": "不行，会直接报错。"}
          ],
          "correct_option_id": "A",
          "feedback": {
            "correct": "对，v1 会被映射成 v2 的形状。",
            "incorrect": "这个选项忽略了向后兼容。"
          },
          "explanation": "解析层保留了 v1 到 v2 的映射。",
          "follow_up": "那 v1 的 feedback 去哪了？"
        }
      ]
    }`;
    await mockApi(page, { "/api/agent/chat": { content: legacyContent } });

    await activateAgent(page);
    await page.locator(".challenge-start").click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog).toContainText("旧格式题干还能渲染吗");
    await dialog.locator(".quiz-option").filter({ hasText: "映射到新的 overlay" }).click();
    await expect(dialog.locator(".quiz-feedback")).toContainText("v1 会被映射成 v2 的形状");
    await expect(dialog.locator(".quiz-feedback")).toContainText("解析层保留了 v1 到 v2 的映射");
  });

  test("challenge problem mode renders a typical major problem card", async ({ page }) => {
    await page.unroute("**/api/**");
    let requestPayload: {
      input?: string;
      messages?: Array<{ content?: string }>;
      modelProviderId?: string;
      model?: string;
      reasoningEffort?: string;
    } | null = null;
    const problemContent = String.raw`{
      "type": "synchropage.challenge_problem.v1",
      "title": "缩放点积注意力典型大题",
      "knowledge_type": "formula",
      "challenge_type": "典型大题",
      "suitability": {
        "has_typical_problem": true,
        "reason": "本页包含注意力打分公式、归一化和适用条件，适合设计多步计算与解释题。",
        "problem_type": "calculation"
      },
      "problem": {
        "stem": "给定查询向量 \vec{q} 和两个键向量 \vec{k}_1, \vec{k}_2，要求判断模型更关注哪个 token。",
        "given": ["打分公式为 s_i = \\frac{\vec{q}\\cdot\vec{k}_i}{\\sqrt{d_k}}。", "softmax 后得到注意力权重。"],
        "tasks": ["写出两个 token 的打分表达式。", "说明为什么要除以 \\sqrt{d_k}。", "判断哪类错误会把注意力误解成硬选择。"],
        "expected_entry": "先确认 q、k 的维度一致，再计算点积 logits。",
        "difficulty": "medium",
        "time_minutes": 8,
        "rubric": ["能先写出 logits，而不是直接比较原始 token。", "能说明缩放项控制 logits 量级。"]
      },
      "coach": {
        "first_hint": "第一步不要急着 softmax，先比较两个未归一化打分。",
        "common_traps": ["把 softmax 权重理解成只能选一个 token。", "忽略 \\sqrt{d_k} 的适用原因。"],
        "after_attempt_check": "检查你的解法是否区分了打分、归一化和加权求和三个阶段。"
      }
    }`;
    await page.route("**/api/**", async (route) => {
      const url = route.request().url();
      if (url.includes("/api/agent/chat")) {
        requestPayload = JSON.parse(route.request().postData() || "{}") as typeof requestPayload;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ content: problemContent }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await activateAgent(page);
    await page.locator(".challenge-kind-option").filter({ hasText: "大题" }).click();
    await page.locator(".challenge-start").click();

    await expect(page.locator(".user-message")).toContainText("典型大题");
    const problem = page.locator(".challenge-problem-card");
    await expect(problem).toBeVisible({ timeout: 10_000 });
    await expect(problem).toContainText("缩放点积注意力典型大题");
    await expect(problem).toContainText("适合典型大题");
    await expect(problem).toContainText("已知条件");
    await expect(problem).toContainText("分问");
    await expect(problem).toContainText("两个 token 的打分表达式");
    await expect(problem).not.toContainText("第一步不要急着 softmax");

    await problem.getByRole("button", { name: "看第一步提示" }).click();
    await expect(problem).toContainText("第一步不要急着 softmax");
    await problem.getByRole("button", { name: "我做完了，看检查点" }).click();
    await expect(problem).toContainText("自查采分点");
    await expect(problem).toContainText("常见误区");
    await expect(problem).toContainText("打分、归一化和加权求和");

    await expect.poll(() => requestPayload?.input || "").toContain("典型大题挑战教练");
    await expect.poll(() => requestPayload?.input || "").toContain("synchropage.challenge_problem.v1");
    await expect.poll(() => requestPayload?.input || "").toContain("不要硬编");
    await expect.poll(() => requestPayload?.modelProviderId || "").toBe("codex_oauth");
    await expect.poll(() => requestPayload?.model || "").toBe("gpt-5.5");
    await expect.poll(() => requestPayload?.reasoningEffort || "").toBe("xhigh");
    await expect.poll(() => requestPayload?.messages?.at(-1)?.content || "").toContain("典型大题");
  });

  test("sending a message via Enter renders mocked assistant reply", async ({ page }) => {
    const composer = await activateAgent(page);
    await composer.click();
    await composer.fill("Test message from e2e");
    await page.keyboard.press("Enter");

    await expect(page.locator(".user-message")).toContainText("Test message from e2e");
    await expect(page.locator(".assistant-message")).toContainText("Mock assistant reply from e2e.", { timeout: 10_000 });
  });

  test("renders malformed inline math from model replies", async ({ page }) => {
    await page.unroute("**/api/**");
    await mockApi(page, {
      "/api/agent/chat": {
        content: [
          "若系统只允许 $0, 1, 2, 3, 4$ 这些值,那么可选状态就是有限集合。",
          "结果通常是近似值,例如 ((0.715)10 $\\to (0.10110$......)2,因为小数可能无法有限表示。",
          "每一位的权值是 `16^0, 16^1, 16^2, ...`,和十进制一致。",
          "例子 `E $\\times 16^2 + 3 \\times 16^1 +$ A $\\times 16^0$`。",
          "$- \\text{组合电路可以看成}“\\text{当前输入} $$\\to$$$ 当前输出”的直接映射。",
          "严格地说,应写作 T(n) $$\\in$$ O(f(n)),表示 $T(n)$ 属于这个集合。",
        ].join("\\n"),
      },
    });

    const composer = await activateAgent(page);
    await composer.click();
    await composer.fill("Render math");
    await page.keyboard.press("Enter");

    const assistant = page.locator(".assistant-message").last();
    await expect.poll(async () => assistant.locator(".katex").count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
    await expect(assistant.locator(".katex-error")).toHaveCount(0);
    await expect(assistant.locator("code")).toHaveCount(0);
    await expect(assistant).not.toContainText("$0, 1, 2, 3, 4$");
    await expect(assistant).not.toContainText("$\\to");
    await expect(assistant).not.toContainText("$-");
    await expect(assistant).not.toContainText("\\text{组合电路");
    await expect(assistant).not.toContainText("$$\\to$$$");
    await expect(assistant).not.toContainText("$$\\in$$");
  });

  test("repairs dielectric physics formula fragments from model replies", async ({ page }) => {
    await page.unroute("**/api/**");
    await mockApi(page, {
      "/api/agent/chat": {
        content: [
          "- 关键结论:介质内部电场不再等于真空中的情形,\\text{介电常数从} $$\\varepsilon_{0}",
          "\\text{介电常数从} \\(\\varepsilon_{0}$ \\text{变为} $\\varepsilon=\\varepsilon_$r$\\varepsilon_{0}",
          "- \\varepsilon_r (relativepermittivity/dielectricconstant) 是**无量纲**材料参数,所以 $\\varepsilon=\\varepsilon_{0}",
          "- 这里用“虚构偶极子”说明偶极矩的基本定义:两个等量异号电荷相距很小的位移时,",
          "\\mathbf{p}=$q\\boldsymbol{$\\delta$$}. - **电子极化**: $外电场 $\\mathbf{E}_{\\text{ext}}$ 使电子云发生形变。",
          "- 当 $\\mathbf{E}_{ext}=0$$ \\text{时,若原本中心重合,则净偶极矩为零。}",
          "- 若孤立偶极子处在外场中,局域电场 $E_{loc}$ 可近似看作施加的宏观场 $E_{ext},\\text{并满足} $$p=\\alpha_$$e E_{loc}$。",
        ].join("\\n"),
      },
    });

    const composer = await activateAgent(page);
    await composer.click();
    await composer.fill("Render dielectric math");
    await page.keyboard.press("Enter");

    const assistant = page.locator(".assistant-message").last();
    await expect.poll(async () => assistant.locator(".katex").count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(7);
    await expect(assistant.locator(".katex-error")).toHaveCount(0);
    const visibleText = await assistant.innerText();
    expect(visibleText).toContain("介电常数从");
    expect(visibleText).toContain("电子极化");
    expect(visibleText).not.toContain("\\text{");
    expect(visibleText).not.toContain("$$");
    expect(visibleText).not.toContain("\\boldsymbol");
    expect(visibleText).not.toContain("\\varepsilon");
  });

  test("renders table math with vertical bars without splitting columns", async ({ page }) => {
    await page.unroute("**/api/**");
    await mockApi(page, {
      "/api/agent/chat": {
        content: [
          "| 比较项 | $T = 3$ | $T = 7$ |",
          "| --- | --- | --- |",
          "| 时域持续时间 | 较短 | 较长 |",
          "| 能量密度 | $|X(\\omega)|^2$ | $|Y(\\omega)|^2$ |",
        ].join("\n"),
      },
    });

    const composer = await activateAgent(page);
    await composer.click();
    await composer.fill("Render table math");
    await page.keyboard.press("Enter");

    const assistant = page.locator(".assistant-message").last();
    const rows = assistant.locator("table tr");
    await expect(rows).toHaveCount(3, { timeout: 10_000 });
    await expect(rows.nth(2).locator("td")).toHaveCount(3);
    await expect(assistant.locator(".katex-error")).toHaveCount(0);
    await expect(assistant).not.toContainText("$|X");
    await expect(assistant).not.toContainText("^2$");
  });

  test("adding an image shows the preview inside the composer", async ({ page }) => {
    await activateAgent(page);
    const imageInput = page.locator('.agent-action-button input[type="file"][accept="image/*"]');
    await expect(imageInput).toHaveCount(1);
    await imageInput.setInputFiles({
      name: "image.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lL+J+wAAAABJRU5ErkJggg==",
        "base64",
      ),
    });

    const composerShell = page.locator(".composer-shell");
    await expect(composerShell.locator(".composer-attachment-preview")).toBeVisible();
    await expect(composerShell.locator(".composer-image-preview")).toContainText("image.png");
  });
});
