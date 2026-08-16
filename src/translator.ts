import { TranslateAllSettingHandler } from "handlers/settings-handler";
import { SupportedLanguages, SupportedSystems } from "types";

// Foundry enrichers: @UUID[...]{label}, @Check[...], @Damage[...],
// &Reference[...] and inline rolls [[...]]. Sending these to a language model
// invites it to translate the arguments or reflow the brackets, which turns a
// working link or roll into plain broken text.
// The inner alternation allows one level of nesting, which real syntax uses:
// @Damage[2d6[fire]] would otherwise be cut at the first bracket and leave a
// stray "]" outside the token for the model to move or drop.
const ENRICHER_PATTERN =
  /(?:[@&][A-Za-z]+\[(?:[^[\]]|\[[^[\]]*\])*\](?:\{[^}]*\})?)|(?:\[\[(?:[^[\]]|\[[^[\]]*\])*\]\])/g;

// Deliberately plain alphanumeric: there is no punctuation for the model to
// reformat, and it is unlikely to be mistaken for a translatable word.
const ENRICHER_TOKEN_PREFIX = "TAREF";

const ENRICHER_INSTRUCTION =
  `The text contains placeholder tokens such as ${ENRICHER_TOKEN_PREFIX}0. ` +
  "Reproduce every token exactly as it appears, unchanged and in the same position. " +
  "Do not translate, renumber, reformat or omit them.";

export class Translator {
  static async translate(description: string): Promise<string | undefined> {
    return await Translator.translateWithChatGPT(description);
  }

  static async getPromptTemplate(path: string, description: string): Promise<string> {
    const promptTemplatePath = TranslateAllSettingHandler.getSetting("translate-all", "promptTemplatePath");
    if (!promptTemplatePath) {
      return "";
    }
    let promptTemplate = "";
    if (promptTemplatePath) {
      try {
        const url = foundry.utils.getRoute(promptTemplatePath);
        promptTemplate = await fetch(url).then((x) => x.text());
      } catch (err) {
        ui?.notifications?.warn(`Could not load prompt template. ${err}`);
      }
    }

    return promptTemplate + `: ${description}`;
  }

  static async generatePrompt(
    system: SupportedSystems,
    language: SupportedLanguages,
    description: string,
  ): Promise<string> {
    const path = TranslateAllSettingHandler.getSetting("translate-all", "promptTemplatePath");
    let prompt = "";
    if (path) {
      prompt = await Translator.getPromptTemplate(path, description);
    } else {
      prompt = `Translate the following ${system} item/spell description into ${language}:\n\n
            Keep the same format and structure, like HTML tags, and do not translate the item name or any specific game terms. 
            Don not add any additional code encapsulation or formatting. Just return the translated text.\n\n
            ${description}.`;
    }

    return prompt;
  }

  static async getModels(): Promise<Record<string, string> | undefined> {
    let response;
    const apiKey = TranslateAllSettingHandler.getSetting("translate-all", "apiKey");
    const apiEndpoint = TranslateAllSettingHandler.getSetting("translate-all", "apiEndpoint");

    try {
      response = await fetch(`${apiEndpoint}/models`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      });
    } catch (error) {
      ui?.notifications?.error(`ChatGPT API call failed. ${error}`);
    }

    if (!response?.ok) {
      ui?.notifications?.error("ChatGPT API call failed.");
      return undefined;
    }

    const data = await response.json();
    const models = data.data.reduce((acc: Record<string, string>, model: { id: string }) => {
      acc[model.id] = model.id;
      return acc;
    }, {});
    return models;
  }

  // Replaces every enricher with an opaque token, returning the tokens in the
  // order they were found so they can be put back afterwards.
  static maskEnrichers(description: string): { text: string; enrichers: string[] } {
    const enrichers: string[] = [];
    const text = description.replace(ENRICHER_PATTERN, (match) => {
      const index = enrichers.push(match) - 1;
      return `${ENRICHER_TOKEN_PREFIX}${index}`;
    });

    return { text, enrichers };
  }

  static restoreEnrichers(translation: string, enrichers: string[]): string {
    if (enrichers.length === 0) {
      return translation;
    }

    const restored = new Set<number>();
    const text = translation.replace(new RegExp(`${ENRICHER_TOKEN_PREFIX}(\\d+)`, "g"), (match, digits) => {
      const index = Number(digits);
      const enricher = enrichers[index];
      if (enricher === undefined) {
        return match;
      }
      restored.add(index);
      return enricher;
    });

    // A model that drops a token silently drops a link or a roll with it, so
    // it is worth saying out loud rather than leaving it to be found in play.
    const lost = enrichers.length - restored.size;
    if (lost > 0) {
      ui?.notifications?.warn(
        `The model did not return ${lost} of the ${enrichers.length} links or rolls in this text; they are missing from the translation.`,
      );
    }

    return text;
  }

  static async translateWithChatGPT(description: string): Promise<string | undefined> {
    let response;
    const apiKey = TranslateAllSettingHandler.getSetting("translate-all", "apiKey");
    const apiEndpoint = TranslateAllSettingHandler.getSetting("translate-all", "apiEndpoint");
    const system = TranslateAllSettingHandler.getSetting("translate-all", "targetSystem");
    const language = TranslateAllSettingHandler.getSetting("translate-all", "targetLanguage");
    const model = TranslateAllSettingHandler.getSetting("translate-all", "targetModel");

    const { text: masked, enrichers } = Translator.maskEnrichers(description);
    const basePrompt = await Translator.generatePrompt(system, language, masked);
    // Appended whatever the prompt source is: it is a mechanical requirement,
    // not a style choice, so a custom prompt should not have to repeat it.
    const prompt = enrichers.length > 0 ? `${basePrompt}\n\n${ENRICHER_INSTRUCTION}` : basePrompt;

    try {
      response = await fetch(`${apiEndpoint}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
        }),
      });
    } catch (error) {
      ui?.notifications?.error(`ChatGPT API call failed. ${error}`);
    }

    if (!response?.ok) {
      ui?.notifications?.error("ChatGPT API call failed.");
      return undefined;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content) {
      return undefined;
    }

    return Translator.restoreEnrichers(content, enrichers);
  }
}
