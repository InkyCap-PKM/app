#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Mettre en forme votre texte",
  description: "Comment mettre en forme du texte dans InkyCap à l'aide de la syntaxe native de Typst, du menu barre oblique et de la barre d'outils de sélection : gras, titres, listes, mathématiques, callouts, tableaux, images et vers.",
  tags: ("documentation",),
)

= Mettre en forme votre texte

Cette page vous montre comment donner à votre écriture l'_apparence_ que vous voulez : texte en gras et en italique, titres, listes, citations, mathématiques, callouts, tableaux, images, et plus encore. Elle s'adresse à quiconque veut des documents soignés et professionnels. Si la rédaction de notes vous est tout à fait nouvelle, commencez d'abord par #wikilink("2 - Modifier des notes") et revenez ici ensuite.

#callout("important")[
  Les raccourcis Markdown ne fonctionnent *pas* dans InkyCap. Apprenez la syntaxe Typst, qui est souvent encore plus rapide. Consultez la #link("https://typst.app/docs/reference/syntax/")[documentation de Typst] pour une référence complète. *Appuyez sur `F1` pendant que vous utilisez InkyCap pour obtenir un aide-mémoire simple*.
]

#highlight()[Ne vous inquiétez pas de tout mémoriser]. Sélectionner du texte fait apparaître une barre d'outils avec des boutons, ou vous pouvez taper *« / »* dans l'éditeur pour obtenir un menu. En *mode visuel*, vos marques se transforment en véritable mise en forme à mesure que vous tapez.

#callout("tip", title: "Vous cherchez une consultation rapide ?")[
  Pour une référence rapide et facile à parcourir qui montre chaque marque que vous tapez *à côté du résultat qu'elle produit*, voir #wikilink("3.1 - Exemples de mise en forme"). Et pendant que vous écrivez, appuyez sur `F1` pour obtenir le même aide-mémoire dans l'application.
]

== Gras, italique et autres marques en ligne

Tapez la marque, votre texte, puis la marque de nouveau. Les plus courantes :

- *Gras* : encadrez avec des astérisques
- _Italique_ : encadrez avec des traits de soulignement (pas des astérisques, qui donnent du gras)
- Code en ligne : encadrez avec des accents graves simples

Voici la syntaxe littérale, pour que vous puissiez voir les marques elles-mêmes :

```typ
This word is *bold* and this one is _italic_.
Use `backticks` for a snippet of code.
```

#callout("tip")[
  Sélectionnez d'abord quelques mots, puis appuyez sur *Ctrl/Cmd+B* pour le gras ou *Ctrl/Cmd+I* pour l'italique, et InkyCap encadre la sélection à votre place. Appuyez de nouveau sur le même raccourci sur du texte déjà en gras pour retirer la mise en forme. Typst ne lit `*` et `_` comme des marques qu'aux extrémités d'un mot ; si vous utilisez le raccourci (ou la barre d'outils) sur une partie d'un mot, InkyCap écrit plutôt `#strong[…]` ou `#emph[…]`, une forme qui fonctionne partout.
]

D'autres effets en ligne (barré, surlignage, souligné, exposant, indice, notes de bas de page) sont accessibles depuis le *menu « / »* et la *barre d'outils de sélection* décrite plus bas, ce qui vous évite de taper leur syntaxe à la main. Quelques-uns ont aussi des raccourcis clavier : *Ctrl/Cmd+Maj+X* pour le barré, *Ctrl/Cmd+Maj+H* pour le surlignage, *Ctrl/Cmd+E* pour le code en ligne et *Ctrl/Cmd+K* pour un lien.

== Titres et structure

Commencez une ligne par un ou plusieurs signes `=` suivis d'une espace. Un seul `=` donne un titre de premier niveau, deux le niveau suivant, et ainsi de suite jusqu'à six :

```typ
= Chapter title
== A section
=== A subsection
==== A fourth heading
===== A fifth heading
====== A sixth heading
```

#callout("note")[
  L'espace après les signes `=` est nécessaire. `=Titre` sans espace ne deviendra pas un titre.
]

En mode visuel, vous pouvez aussi hausser ou abaisser le niveau du titre courant avec *Ctrl+Maj+Haut* et *Ctrl+Maj+Bas*, sans retaper les signes.

== Listes

Commencez chaque ligne par un marqueur et une espace :

- Une puce utilise un trait d'union : `- item`
- Une liste numérotée utilise un plus : `+ item` (InkyCap la numérote pour vous, de sorte que vous pouvez réordonner librement)
- Pour des numéros fixes, utilisez `1. item`
- Pour une liste de termes et définitions, utilisez `/ Term: definition`

```typ
- First point
- Second point

+ Step one
+ Step two
```

Quand vous travaillez dans une liste, *Entrée* commence automatiquement l'élément suivant, et appuyer sur Entrée sur un élément vide met fin à la liste. *Tab* et *Maj+Tab* augmentent et diminuent le retrait des éléments, et *Maj+Alt+Haut / Bas* déplace un élément vers le haut ou le bas, avec ses éléments imbriqués, tout en gardant la numérotation soignée. Quelques petites attentions de plus :

- *Début* (Home) place le curseur sur le texte de l'élément, juste après la puce, et la *flèche gauche* au début du texte d'un élément recule jusqu'à la fin de la ligne du dessus.
- Les numéros fixes `1.` ne sont renumérotés que lorsque la forme de la liste change (un élément mis en retrait, sorti du retrait ou déplacé). Une liste que vous commencez délibérément à `5.` continue avec 5, 6, 7.
- Un élément de liste qui contient des éléments imbriqués peut être *replié* : survolez à sa gauche et cliquez sur le chevron qui apparaît. Voir #wikilink("2 - Modifier des notes") pour en savoir plus sur le repliement.

== Citations, callouts et surlignages

Une *citation en bloc* met en valeur un passage, souvent pour citer une source. Tapez `> ` au début d'une ligne et InkyCap la transforme en un véritable bloc de citation pour vous ; si la ligne contient déjà du texte, ce texte devient la citation. Faites un clic droit sur la pastille de la citation pour ses options : *Style* (*Bloc* ou *En ligne*), une *Attribution* (du texte simple, ou une clé de bibliographie écrite `<clé>` pour qu'elle pointe vers votre liste de références) et une *URL du lien* qui transforme l'attribution en lien.

Les *callouts* sont les boîtes teintées et encadrées que vous avez vues sur cette page, parfaites pour les astuces, les avertissements et les exemples travaillés. Insérez-en un depuis le menu « / » (choisissez *Mise en avant*) ou la barre d'outils de sélection, puis choisissez le type en faisant un clic droit sur sa `#pill`. InkyCap propose quinze types, chacun avec sa propre couleur :

- *note*, *tip*, *info*, *abstract*, *quote*
- *warning*, *caution*, *important*, *danger*, *failure*, *bug*
- *example*, *question*, *todo*, *success*

Le type détermine le mot et la couleur de la boîte, et vous pouvez remplacer l'un ou l'autre depuis le menu de la pastille : tapez vos propres *mots de titre* dans le champ Titre, ou choisissez la *couleur* qui vous plaît. Le type reste dans la note dans les deux cas, de sorte qu'effacer le titre, ou choisir « Selon le type », remet la boîte dans son état de départ.

La forme littérale, si jamais vous voulez en taper un directement, est :

```typ
#callout("warning")[ Save your work before exporting. ]
#callout("tip", title: "My own title")[ You can rename the box. ]
#callout("note", color: rgb("#7c4dff"))[ Any colour you like. ]
```

Pour *surligner* du texte, sélectionnez-le et utilisez le surligneur de la barre d'outils (ou *Ctrl/Cmd+Maj+H*). Vous pouvez changer la couleur du surlignage depuis son menu de pastille : *Rouge*, *Orange*, *Jaune* (par défaut), *Vert*, *Bleu*, *Violet* ou *Rose*.

== Le menu barre oblique « / »

Tapez `/` au début d'une ligne ou juste après une espace, puis commencez à taper ce que vous voulez, et le menu se filtre à mesure. Utilisez les touches fléchées, *Entrée* ou *Tab* pour accepter, *Échap* pour fermer, et la *flèche droite* pour ouvrir un sous-menu. Quand une fonctionnalité a aussi un raccourci de frappe rapide, le menu l'affiche à l'extrémité droite de la rangée.

Les entrées sont regroupées dans ces catégories :

- *Format* : gras, italique, barré, surlignage, souligné, surligné supérieur, indice, exposant, code en ligne, mathématiques en ligne
- *Structure* : titres, listes à puces/numérotées/de termes, citations en ligne et en bloc
- *Insérer* : liens, images, vidéo, audio, blocs de code, blocs de mathématiques, filets horizontaux, notes de bas de page, citations, tableaux, figures, sauts de page et de ligne, callouts, et plus
- *Symbole* : tiret cadratin, tiret demi-cadratin, points de suspension, espace insécable, et un ensemble soigné d'autres symboles
- *InkyCap* : liens wiki, vers, tâches, échéances, annotations et modifications suggérées
- *Style* : taille de page, marges, numérotation, colonnes, polices, taille et langue du texte, justification et espacement
- *Outils* : éléments fournis par des outils externes (voir #wikilink("4 - Extensions"))

== La barre d'outils de sélection

Chaque fois que vous sélectionnez du texte dans l'éditeur visuel à la main (par glissement, double ou triple clic, ou en maintenant Maj et en utilisant les touches fléchées), une petite barre d'outils apparaît au-dessus de votre sélection. Elle vous donne un accès en un clic aux mises en forme les plus courantes :

- Un *menu déroulant de type de bloc* pour transformer la sélection en liste à puces, liste numérotée, titre (niveaux 1 à 6), surlignage ou callout, ou la ramener à *Texte normal*
- *Gras*, *Italique*, *Souligné*, *Barré*
- *Exposant*, *Indice* et *Note de bas de page*
- *Lien*, *alignement du texte* (gauche, centre, droite), *vers*, *code en ligne* et *maths en ligne*

Chaque bouton en ligne fonctionne à bascule : cliquez une fois pour appliquer la mise en forme, cliquez de nouveau sur le même texte pour la retirer. La barre d'outils reste à l'écart à l'intérieur des blocs de code.

== Mathématiques

InkyCap offre des mathématiques de première classe, mais sachez que la plupart des mathématiques s'affichent en mode lecture ou dans des sorties comme le PDF, pas en mode Édition visuelle. Encadrez une expression avec des signes de dollar :

- *Les mathématiques en ligne* se placent dans votre phrase : `$x^2$`
- *Les mathématiques d'affichage* sont centrées sur leur propre ligne ; ajoutez des espaces juste à l'intérieur des signes de dollar : `$ x^2 $`

```typ
The identity $e^(i pi) + 1 = 0$ is famous.

$ sum_(k=1)^n k = (n (n+1)) / 2 $
```

Vous pouvez aussi insérer des mathématiques depuis la barre d'outils (le bouton *∑*) ou le menu « / ». Pendant que votre curseur se trouve à l'intérieur d'une équation, l'éditeur visuel l'affiche en source brute pour que vous puissiez la modifier ; le texte environnant ne bouge pas pendant que vous tapez le `$` de fermeture.

== Tableaux

Choisissez *Tableau* dans le menu « / » pour déposer une grille de départ. Dans l'éditeur visuel, elle devient un tableau interactif avec lequel vous pouvez travailler directement :

- Cliquez sur une cellule pour *la modifier sur place*. Une cellule est un petit morceau de la note, de sorte que tout ce que vous pouvez faire dans le corps fonctionne à l'intérieur : liens wiki, gras et italique, le menu « / », la correction orthographique.
- Déplacez-vous entre les cellules avec *Entrée* et *Tab* ; *Début* (Home) et *Fin* (End) sautent à la première ou à la dernière cellule de la ligne. Quand une cellule est sélectionnée, commencez simplement à taper pour remplacer son contenu.
- *Faites glisser le bord d'une colonne* pour régler sa largeur, ou *double-cliquez sur le bord* pour l'ajuster au contenu. Les lignes grandissent avec leur contenu ; si un tableau a des hauteurs de ligne fixes, l'option *Ajuster les lignes au contenu* du menu de ligne les retire.
- *Faites un clic droit sur la poignée de coin* (en haut à gauche) pour les options du tableau entier : *Copier le tableau* (sous forme de texte séparé par des tabulations que vous pouvez coller dans un tableur), *Réinitialiser la largeur des colonnes*, *Définir comme en-tête* ou *Retirer l’en-tête* pour la première ligne, *Modifier la source* et *Supprimer le tableau*.
- *Faites un clic droit sur une poignée de ligne ou de colonne* pour insérer, supprimer, dupliquer ou déplacer des lignes et des colonnes, trier selon une colonne ou régler l'alignement d'une colonne. *Faites glisser une poignée* pour réordonner les lignes ou les colonnes.
- *Collez* une grille copiée depuis un tableur directement dans le tableau

== Images et médias

Pour ajouter une *image*, choisissez *Image* dans le menu « / » (cela ouvre un sélecteur de fichiers), ou *faites simplement glisser un fichier dans l'éditeur* ou *collez* une image. Quelle que soit la façon de l'ajouter, InkyCap copie le fichier dans le dossier de pièces jointes de votre boîte de notes, pour que l'image voyage avec vos notes.

Une fois en place, vous pouvez régler le chemin du *Fichier*, la *largeur*, le *texte alternatif* et l'*alignement* de l'image depuis son menu de pastille dans l'éditeur visuel. Une image simple se place à gauche ; l'alignement centré ou à droite est disponible quand vous le voulez. Faites un clic droit sur l'image elle-même pour *Afficher dans l'arborescence des fichiers* et *Afficher dans le gestionnaire de fichiers du système*, qui vous mènent au fichier derrière elle.

InkyCap prend en charge la *vidéo* et l'*audio*. Ils se lisent en direct dans l'éditeur. Quand vous publiez vers une page web, ils deviennent de véritables lecteurs ; dans un PDF (qui ne peut pas lire les médias), ils apparaissent comme un substitut soigné nommant le fichier. Voir #wikilink("3 - Exportation et publication") pour savoir ce que chaque format de sortie prend en charge.

== Vers : une écriture qui garde sa forme

Pour la poésie ou tout autre texte où l'espacement et le retrait exacts comptent, utilisez les *vers*. Contrairement aux paragraphes ordinaires (où le moteur de mise en page condense les espaces supplémentaires), les vers préservent chaque espace exactement comme vous l'avez tapé, de sorte qu'un retrait délibéré ou des lignes supplémentaires survivent. Insérez-les depuis le menu « / » (*Vers*) ou le bouton *vers* de la barre d'outils de sélection.

Contrairement à bien d'autres outils de gestion des connaissances qui ne fournissent qu'un bloc de code préformaté maladroit, le mode vers d'InkyCap vous laisse travailler avec votre police habituelle, et vous pouvez encore utiliser la mise en forme en ligne à l'intérieur des vers : *gras*, _italique_, surlignages et liens fonctionnent tous ligne par ligne.

Les vers acceptent des options d'alignement, de numérotation des lignes et d'espacement des lettres, et vous pouvez définir une police de vers par défaut pour toute la boîte de notes. Ils s'insèrent dans le flux normal de la sortie du document.

== Pour les utilisateurs de Typst

#callout("tip", title: "Pour les utilisateurs de Typst")[
  Tout dans l'éditeur est du balisage Typst pur, et vous pouvez toujours basculer en Typst brut pour faire tout ce que les menus ne font pas surgir : règles set, règles show, fonctions personnalisées, packages. Les appels de fonction que vous écrivez apparaissent derrière une petite pastille `#` cerclée dans l'éditeur visuel ; cliquez dessus pour révéler et modifier la source en ligne, ou faites un clic droit pour un menu avec *Modifier la source*, *Ouvrir dans l'éditeur de source* et *Copier / Dupliquer / Retirer le style / Supprimer*. Basculez en mode source à tout moment pour voir et modifier directement le Typst complet.
]

== Pages connexes

- #wikilink("3.2 - Mise en forme avancée"). Le menu Style : les règles set de page, de police et d'espacement qui apparaissent dans les exportations et la vue de lecture
- #wikilink("2 - Modifier des notes"). Les modes d'édition et les bases du travail dans une note
- #wikilink("4 - Liens et rétroliens"). Relier les notes avec des liens wiki
- #wikilink("7 - Citations et bibliographie"). Ajouter des références et une liste de lectures
- #wikilink("3 - Exportation et publication"). Transformer vos notes mises en forme en PDF et en pages web
