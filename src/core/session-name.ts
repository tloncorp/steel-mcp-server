// ABOUTME: Readable session names sampled independently of the caller and browser identity.
// ABOUTME: Registries reserve each name before returning it; a name never grants access by itself.
import { randomInt } from 'node:crypto';

export const SESSION_ADJECTIVES = `
able active agile airy alert ample apt arctic awake balanced bashful beaming bold bouncy brave breezy
bright brisk bubbly calm candid careful caring casual chatty cheerful clever cozy crisp curious dapper daring
dashing dainty deft eager early easy elated elegant even fair fancy fast fearless festive fine fit
fluffy fond frank free fresh friendly frosty funny gentle gifted glad glowing golden grand grateful great
happy hardy helpful honest humble icy ideal jolly joyful keen kind lively little lofty lovely loyal
lucky mellow merry mighty mild misty modest neat nimble noble noted novel odd open patient peaceful
peppy perky playful pleased plucky polite proud quick quiet quirky rapid ready regal relaxed rich rosy
round royal rugged sandy savvy sharp shiny shy silly sleek sleepy slim smart smooth snug soft
solid spry steady still stout strong sunny super swift tall tidy tiny true upbeat vivid warm
`
    .trim()
    .split(/\s+/);

export const SESSION_COLORS = `
amber aqua azure beige black blue bronze brown coral cream cyan gold gray green indigo ivory
jade lavender lemon lilac lime magenta mint navy olive orange peach pink purple red silver teal
`
    .trim()
    .split(/\s+/);

export const SESSION_ANIMALS = `
albatross alpaca ant badger bat bear beaver bee beetle bison boar bobcat buffalo bunny butterfly camel
canary capybara cardinal caribou cat cheetah chicken chipmunk clam cobra cod condor cougar cow coyote crab
crane cricket crow deer dingo dog dolphin donkey dove dragonfly duck eagle eel egret elk emu
falcon ferret finch flamingo flea fly fox frog gazelle gecko gerbil gibbon giraffe goat goose gopher
gorilla grouse gull hamster hare hawk hedgehog heron hippo horse husky hyena ibis iguana impala jaguar
jay jellyfish kangaroo kestrel kiwi koala koi lamb lark lemur leopard lion lizard llama lobster lynx
macaw magpie manatee mantis marmot mink mole mongoose monkey moose moth mouse mule newt octopus orca
oriole ostrich otter owl ox oyster panda panther parrot peacock pelican penguin pheasant pigeon pony puffin
quail rabbit raccoon ram rat raven rhino robin salmon seal shark sheep skunk sloth snail snake
sparrow squid squirrel stork swan tiger toad trout turkey turtle viper vole walrus whale wolf zebra
`
    .trim()
    .split(/\s+/);

/** Returns a candidate; uniqueness belongs to the registry's atomic reservation. */
export function mintHandle(): string {
    return [SESSION_ADJECTIVES, SESSION_COLORS, SESSION_ANIMALS].map(words => words[randomInt(words.length)]).join('-');
}

/** Bound contention and exhausted namespaces instead of spinning indefinitely. */
export const HANDLE_ALLOCATION_ATTEMPTS = 128;
