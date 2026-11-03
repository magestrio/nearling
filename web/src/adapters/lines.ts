// The words of Adapter sheet, the sockets of Skill sheet and the skill-code lines the Skill sheet carries (add-pet-errands › Adapter
// sheet screen, Adapter connect flow, Catalog flow, Skill code flow), verbatim from the Scenarios and the frames' `copy`
// (design/bundle/screens/adapter.js, skill.js, code.js).
import { joinLabels } from '../errands/lines';

export { joinLabels };

export const adapterTitle = (name: string) => `Connect data to ${name}'s skill`;
export const connectedTitle = (label: string, name: string) => `${label} on ${name}'s skill`;
export const NAME_FIELD = 'Name it';
export const nameHint = (name: string) => `Anyone asking ${name} for help sees this name`;
export const ADDRESS_FIELD = 'Address';
export const ADDRESS_HINT = 'Only keyless public data works here. Never paste a key or a password.';
export const CHECK_ADDRESS = 'Check address';
export const BROWSE_CATALOG = 'Browse the catalog';
export const TOOLS_LABEL = 'Tools';
export const SAVE_ADAPTER = 'Save adapter';
export const REMOVE = 'Remove';
export const ADDRESS_FAILED = "That address didn't work. Use a plain https address that answers with no key. Nothing was saved.";
export const ADAPTER_ERROR = "We couldn't save that. Nothing's lost — try again.";
export const freeTextNote = (name: string) => `Takes free text — ${name} can only send short names, numbers, addresses or a pick from a list.`;
export const noneFitLine = (name: string) => `None of these tools fit, so ${name} can't use this one.`;

export const PUBLISH = 'Publish to the catalog';
export const PUBLISH_NOTE = "Anyone will see this adapter's address and what its tools do, and can connect it to their pet's skill for free.";
export const IN_CATALOG = 'In the catalog.';
export const TAKE_OUT = 'Take it out';
export const publishRefusedLine = (name: string) => `Some words in this adapter's address, tool names or descriptions can't go in the catalog. It still works for ${name}.`;
export const giftLine = (name: string) => `This adapter came with ${name} as a gift, so it can't go in the catalog. It still works for ${name}.`;

export const connectedLine = (name: string, label: string) => `Connected. ${name} can use ${label} from its next job.`;
export const removedLine = (name: string, label: string) => `${label} removed. ${name} stops using it from its next job.`;

// the sockets of Skill sheet
export const SOCKET_DATA = 'Connect data';
export const SOCKET_CODE = 'Add code';
export const codeSocket = (name: string) => `${name}'s code`;
export const NO_SKILL_YET = 'Save the skill first, then connect data to it.';
export const FOURTH_SOURCE = 'A skill holds up to 3 data sources. Remove one to add another.';
export const goneNote = (name: string) => `No longer in the catalog — still works for ${name}.`;
export const codeSavedLine = (name: string) => `Saved. ${name} can run its code from its next job.`;
export const codeRemovedLine = (name: string) => `Code removed. ${name} stops running it from its next job.`;

// the words of Adapter catalog (add-pet-errands › Adapter catalog screen), from the Scenarios and design/bundle/screens/catalog.js
export const CATALOG_TITLE = 'Adapter catalog';
export const CATALOG_LABEL = 'Adapters';
export const CATALOG_LOADING = 'Loading the catalog…';
export const CATALOG_ERROR = "We couldn't load the catalog. Try again in a moment.";
export const CATALOG_EMPTY = "No adapters yet. Owners can publish theirs from their pet's skill.";
export const BROWSE_ONLY = "To connect one, open your pet's skill and tap “Connect data”.";
export const NO_PET_LINE = "Every adapter here is free. To connect one, you'll need a pet of your own.";
export const SIGNED_OUT_LINE = "Sign in to connect one to your pet's skill.";
export const GET_OWN_PET = 'Get your own pet';
export const backTo = (name: string) => `Back to ${name}`;
export const connectTo = (name: string) => `Connect to ${name}'s skill`;

// the words of Skill code sheet (add-pet-errands › Skill code sheet screen, Skill code flow), from the Scenarios and design/bundle/screens/code.js
export const CODE_FIELD = 'JavaScript, up to 32 KB';
export const codeFieldHint = (name: string) => `Declare ${name}'s functions in export const functions.`;
export const CODE_REACH = "Your code can reach only this skill's data sources. It runs apart from the game, with a time limit.";
export const CODE_PRIVATE = "Only you can see this code. It's never shown to other players or sent to NEAR AI.";
export const FN_FIELD = 'Function to test';
export const SAMPLE_FIELD = 'Sample values';
export const SAMPLE_HINT = 'e.g. BTC, 7';
export const TEST_RUN = 'Test run';
export const SAVE_CODE = 'Save code';
export const REMOVE_CODE = 'Remove code';
export const changingFunctionsLine = (name: string) => `Changing which functions ${name} can call? Run one test first, then save.`;
export const STALE_TEST_LINE = 'A new day started since your last test. Run one test, then save.';
export const FUNCTIONS_LABEL = 'Functions';
export const CODE_LIMIT_LINE = 'Your code ran past its limits. Make it lighter and test again.';
export const CODE_ERROR_LINE = 'Your code stopped with an error:';
export const notDeclaredLine = (fn: string) => `${fn} isn't in export const functions, so nothing ran. Declare it there and test again.`;
export const testCapLine = (time: string) => `That's all the test runs for today. Your code is still here — test it again at ${time}.`;
export const gameCapLine = (time: string) => `The game has run all the code it can for today. Your code is still here — test it again at ${time}.`;
