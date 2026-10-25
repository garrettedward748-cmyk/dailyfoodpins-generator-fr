import { describe, it, expect } from 'vitest';
import { haramWord } from '../src/core/halal.js';
describe('halal filter on French text', () => {
  const bad = ['Déglacez avec un verre de vin blanc.', 'Ajoutez 100 g de lardons fumés', 'Une bière blonde pour la pâte', 'sauce au porc', 'saucisson sec', 'flambé au rhum', 'jambon blanc', 'Pâté de campagne'];
  const good = ['Légumes de saison, poêlés', 'Ajoutez une cuillère de vinaigre de vin rouge.', 'Œufs mimosa au thon', 'Bacon de dinde croustillant', 'Lardons de dinde', 'Bière sans alcool', 'Un gâteau à la vanille bourbon', 'Poulet rôti au citron', 'Salade de concombre et menthe', 'des vinaigrettes maison'];
  for (const t of bad) it('flags: ' + t, () => expect(haramWord(t)).not.toBeNull());
  for (const t of good) it('passes: ' + t, () => expect(haramWord(t)).toBeNull());

  it('does not find English drink names inside French words, nor refuse ordinary French words', () => {
    for (const t of ['la texture idéale', 'des céréales du matin', 'goût amer du caramel', 'biscuits digestifs',
      'raisin muscat', 'poivre rosé', 'pigé ?', 'noix de muscade'])
      expect(haramWord(t)).toBeNull();
    for (const t of ['un verre de rosé', 'une bière', 'pale ale', 'du vin blanc'])
      expect(haramWord(t)).not.toBeNull();
  });
});
