import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { haramIn, haramWord } from '../src/core/halal.js';

beforeEach(() => openDatabase(':memory:'));
afterEach(() => closeDatabase());

describe('halal words', () => {
  it.each([
    'Champagne Strawberries',
    'Add 2 tbsp of Marsala wine to the filling',
    'Tiramisu with rum and coffee',
    'Prosecco Jelly Cups',
    'Sangria Cake',
    'Amaretto Cheesecake',
    'Bourbon Pecan Pie',
    'Bacon Brownies',
    'Mulled wine cupcakes',
    'Pinot noir chocolate cake',
    'Aperol dessert',
    'Hot dogs on a stick',
    'Sprinkle with prosecco',
    'Red wine reduction brownies', 'Guinness chocolate cake', 'Mai Tai cupcakes', 'Limoncello tiramisu', 'Beer-battered donuts',
    'Cherry kirsch parfait', 'Wild boar chili', 'Pigs feet stew', 'Bacon fat cookies', 'Ham hocks and beans', 'Pork chops with apples',
    'Rums and spirits-soaked fruit cake', 'Shiraz glaze', 'Soppressata pizza',
  ])('refuses “%s”', (t) => expect(haramWord(t)).not.toBeNull());

  it.each([
    'Old fashioned oats with a spritz of lemon',
    'Bourbon vanilla extract and Madagascar bourbon vanilla',
    'Apple cider donuts with apple cider',
    'Serrano peppers, minced',
    'For goodness\u2019 sake, do not overmix',
    'For the sake of speed use a mixer',
    'Made without the use of alcohol',
    'Virgin mojito with ginger ale and root beer',
    'Beef bacon bits and turkey ham',
    'A shot of espresso',
  ])('allows “%s”', (t) => expect(haramWord(t)).toBeNull());

  it('finds a word inside written content, ignoring tags', () => {
    expect(haramIn({ title: 'Lemon Bars', ingredients: ['1 cup sugar', '2 tbsp limoncello'] })).toBe('limoncello');
    expect(haramIn('<p>Plain <strong>lemon</strong> bars</p>')).toBeNull();
    expect(haramIn('<a href="/wine">x</a> fine')).toBeNull();
  });
});
