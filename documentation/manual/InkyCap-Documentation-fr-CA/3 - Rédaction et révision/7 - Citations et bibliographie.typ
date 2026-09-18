#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Citations et bibliographie",
  description: "Comment connecter une bibliographie (fichier ou Zotero), parcourir et insérer des citations, choisir un style de citation, générer la liste des références, copier une bibliographie mise en forme et lire les avertissements de citation.",
  tags: ("documentation",),
)

= Citations et bibliographie

InkyCap est conçu pour l'écriture universitaire dans toutes les disciplines : il traite donc les citations et votre bibliographie comme des outils de première classe. Cette page vous montre comment connecter vos références, citer une source en quelques frappes, choisir un style de citation et laisser InkyCap construire votre liste de références pour vous. Si l'éditeur vous est nouveau, vous voudrez peut-être lire d'abord #wikilink("1 - Rédaction et révision").

== La version rapide

Processus de base pour citer dans InkyCap :

+ Pointez InkyCap vers vos références une fois, dans #wikilink("2 - Paramètres") sous l'onglet *Citations* (un fichier BibTeX ou votre base de données Zotero locale).
+ Pendant que vous écrivez, tapez `@` et choisissez l'ouvrage voulu. InkyCap insère une courte clé de citation comme `@otlet1934`.
+ Quand vous lisez ou exportez la note, InkyCap rassemble automatiquement vos citations dans une liste de références mise en forme à la fin, dans le style que vous avez choisi.

Le reste de cette page explique chaque étape et les options qui l'entourent.

== Connecter vos références

Ouvrez #wikilink("2 - Paramètres") et allez à l'onglet *Citations*. Le premier choix est *Source des citations* (où InkyCap cherche vos informations bibliographiques). Vous avez deux options.

=== Option 1 : un fichier de bibliographie

Choisissez *Fichier de bibliographie (.bib, .yml, .json)*. C'est la valeur par défaut, et elle couvre les formats de références les plus courants :

- Les fichiers *BibTeX* (`.bib`), le format que la plupart des gestionnaires de références peuvent exporter.
- Les fichiers *Hayagriva YAML* (`.yml` ou `.yaml`).
- Les fichiers *CSL JSON* (`.json`).

Dans le champ *Fichier de bibliographie*, vous donnez un chemin relatif à la boîte de notes, comme `references.bib`. Si vous le laissez vide, InkyCap détecte un fichier pour vous, cherchant `references.bib`, puis `references.yml`, puis `references.json`, et utilisant le premier qu'il trouve. Vous pouvez aussi cliquer sur *Parcourir* pour choisir un fichier ; s'il se trouve à l'intérieur de votre boîte de notes, InkyCap stocke le chemin relatif à la racine de votre boîte de notes pour qu'il reste portable.

#callout("tip")[ La configuration la plus simple est de déposer un fichier nommé `references.bib` à la racine de votre boîte de notes et de laisser le champ de chemin vide. InkyCap le trouvera tout seul. ]

=== Option 2 : votre base de données Zotero

Si vous gardez vos références dans #link("https://zotero.org")[Zotero], choisissez *Base de données Zotero*. InkyCap lit alors directement depuis votre bibliothèque Zotero stockée sur votre ordinateur local.

Dans le champ *Chemin de la base de données Zotero*, vous pointez InkyCap vers votre fichier `zotero.sqlite`. Le plus facile est de cliquer sur *Détecter*, qui cherche automatiquement les emplacements habituels sur votre ordinateur (il affiche *Détection…* pendant qu'il travaille). Comme c'est l'emplacement de votre installation Zotero, c'est un réglage *global*. Une fois défini, il s'applique à toutes vos boîtes de notes.

#callout("note")[ Quand vous sélectionnez Zotero comme source de références, InkyCap génère son propre fichier de bibliographie à partir de votre bibliothèque Zotero (à `.inkycap/zotero-export.bib`), ce qui permet au reste de la machinerie de citation de l'application de lire cette information. Il est créé automatiquement et tenu à jour ; vous n'avez pas à le gérer. Cependant, si vous apportez des changements à une référence dans Zotero pendant que vous utilisez InkyCap, vous pouvez forcer un rafraîchissement rapide dans InkyCap en cliquant sur le bouton *Actualiser la bibliographie* en haut à droite du panneau Références. ]

== Choisir un style de citation

Le réglage *Style de citation* contrôle la mise en forme de vos citations et de votre liste de références (auteur-date, notes de bas de page, numéroté, et ainsi de suite). La valeur par défaut est *Chicago (Author-Date)*. Les styles intégrés comprennent :

- *Chicago (Author-Date)* et *Chicago (Notes)*
- *APA* et *APA (7th)*
- *MLA*
- *IEEE*
- *ACM*, *ACS*, *AIP*, *AMA*
- *Future Medicine*, *GB/T 7714 (Numeric)*

Si votre discipline ou votre éditeur a besoin d'un style absent de la liste, choisissez *Custom CSL file…* et pointez InkyCap vers un fichier de style `.csl` à l'aide de *Parcourir…*. Un style personnalisé se définit par boîte de notes et a préséance sur le style nommé global. Obtenez plus de styles auprès du #link("https://citationstyles.org/")[projet Citation Style Language].

#callout("important")[ Le style de citation que vous choisissez ici est une *valeur par défaut*. Comme le réglage lui-même le note, cela « peut être remplacé dans la sortie rendue par fichier ou par collection ». Ainsi, une boîte de notes peut être par défaut en Chicago tandis qu'une #wikilink("2 - Collections", display: "Collection") particulière est réglée pour utiliser son propre style et publie une sortie en MLA. ]

#callout("tip", title: "Pour les utilisateurs de Typst")[ InkyCap n'invente pas son propre format de citation. Il utilise les citations natives de Typst de bout en bout. Les noms de styles correspondent aux styles CSL archivés de hayagriva, et toute la mise en forme passe par hayagriva (le même moteur derrière le `#bibliography` de Typst). L'ordre de résolution est : un fichier `.csl` personnalisé par boîte de notes, puis le style nommé global, puis un repli vers `chicago-author-date`. La sélection de source, le chemin de bibliographie et le chemin CSL personnalisé sont par boîte de notes ; le style nommé par défaut et le chemin de la base de données Zotero sont globaux. ]

== La barre latérale Références

Une fois une source configurée, ouvrez l'onglet *Références* dans le panneau de droite (son icône est un guillemet, à côté de l'onglet Liens). C'est votre base d'attache pour tout ce qui touche aux citations. Il comporte deux parties.

=== Parcourir les références

Cliquez sur *Parcourir les références* pour déployer la liste de chaque ouvrage de votre bibliographie. De là, vous pouvez :

- *Filtrer* la liste. Tapez dans la boîte *Filtrer les entrées…* pour faire une recherche approximative par clé, titre, auteur ou année. Encadrez votre texte de `"guillemets doubles"` pour une correspondance de phrase exacte.
- *Trier* avec le menu de tri, qui propose *Date d'ajout (récent – ancien)* (par défaut), la date d'ajout dans l'autre sens, et le titre, l'auteur ou l'année, chacun en ordre croissant ou décroissant. Votre choix est mémorisé.
- *Actualiser la bibliographie* recharge votre bibliographie (et, pour Zotero, la réexporte) pour que les ouvrages nouvellement ajoutés apparaissent.

Un petit badge vous indique combien d'entrées vous avez et si elles proviennent de *Zotero* ou d'un *Fichier*. Si certaines entrées n'ont pu être lues, vous verrez une note « ignorées » expliquant que quelques entrées avaient des erreurs de mise en forme dans la source.

*Pour insérer une citation, cliquez simplement sur une rangée.* InkyCap dépose `@key` là où votre curseur se trouve dans la note courante. Si une référence provenait de Zotero, la rangée offre aussi un lien *Ouvrir dans Zotero*.

#callout("note")[ Si vous voyez « Aucune bibliographie configurée. Vérifiez Paramètres › Citations. », cela veut dire qu'InkyCap n'a pas encore trouvé de source. Retournez à l'onglet *Citations* et définissez-en une. ]

=== Citations dans ce fichier

Sous le navigateur, la section *Citations* liste chaque ouvrage cité dans la note que vous êtes en train de modifier, dédupliqué. C'est une façon rapide de voir vos sources d'un coup d'œil. Quand la note cite au moins un ouvrage, un bouton *Copier la bibliographie mise en forme* apparaît ici aussi. Il y a plus là-dessus ci-dessous.

== Insérer une citation pendant que vous écrivez

Il y a trois façons de citer, alors vous pouvez utiliser celle qui convient à votre flux.

=== Taper @ (la plus rapide)

Tapez `@` n'importe où dans votre texte et un menu surgissant de recherche s'ouvre sur toute votre bibliographie, avec un volet d'aperçu montrant les auteurs, l'année, le titre et le type d'entrée. Ensuite :

- *Flèche haut / Flèche bas* pour parcourir les résultats,
- *Entrée* ou *Tab* pour accepter (cela insère `@key` et ferme le menu),
- *Échap* pour fermer.

Vous n'avez pas besoin de connaître la clé de citation. La recherche fait correspondre des mots n'importe où dans la clé, le titre, les auteurs et l'année, de sorte que `@smith`, `@2020` et `@gravitational` peuvent tous trouver le même article. Séparez plusieurs mots par des espaces (`@smith 2020`) et seuls les ouvrages qui correspondent à tous ces mots restent dans la liste. Si vous continuez à taper et que plus rien ne correspond, le menu surgissant se ferme discrètement et votre `@` reste du texte ordinaire. Voici à quoi ressemble une citation finie dans votre source :

```typ
@otlet1934
```

Les citations de style Typst acceptent aussi une page ou un autre complément :

```typ
@otlet1934[p. 64]
```

Si jamais vous devez écrire l'arobase (`@`) au début d'un mot, échappez-la d'abord avec une barre oblique inverse `\` pour qu'InkyCap ne la prenne pas pour une citation. InkyCap détecte les adresses de courriel. Quand le `@` est collé à la fin d'un mot, comme dans `user@domain.com`, InkyCap le lit comme une partie d'une adresse : le menu surgissant reste fermé pendant que vous la tapez, l'éditeur visuel l'affiche comme texte brut et la note compile toujours.

```typ
\@notacitation
```

=== Pointer vers des figures, des tableaux et des équations

Le même menu surgissant `@` fait plus que citer. Sous le groupe *Bibliographie*, il liste les endroits étiquetés de la note que vous écrivez, regroupés en *Titres*, *Figures*, *Équations*, *Tableaux* et *Étiquettes*. Choisissez-en un et InkyCap écrit le renvoi pour vous, sous la forme qui fonctionnera vraiment :

- Une cible qui porte un numéro (une figure, un tableau, une équation numérotée ou un titre dans une note qui numérote ses titres) est insérée comme `@label`, qui se rend comme ce numéro (par exemple, « Figure 2 »).
- Une cible sans numéro (un titre dans une note sans numérotation des titres, ou une étiquette sur de la prose ordinaire) est insérée comme lien textuel, `#link(<label>)[...]`, avec le libellé sélectionné pour que vous puissiez taper le vôtre tout de suite. Le texte gris à droite de chaque rangée vous indique quelle forme il écrira avant que vous choisissiez.

Le menu surgissant ne voit que la note dans laquelle vous êtes. Pour pointer vers un titre ou une étiquette dans une _autre_ note, utilisez plutôt un lien wiki avec `::` (voir #wikilink("4 - Liens et rétroliens")).

=== Chercher des références et citer

Appuyez sur `Ctrl+Shift+C` pour ouvrir le sélecteur *Rechercher des références et citer*, une surcouche ciblée où vous pouvez chercher par clé, titre ou auteur et appuyer sur *Entrée* pour insérer la citation. C'est pratique quand vous voulez une surface de recherche plus grande que le menu surgissant en ligne.

=== Les menus barre oblique et de commandes

Tapez `/` pour la palette de commandes et choisissez *Citation* pour démarrer une citation à votre curseur, ou *Bibliographie* pour insérer un appel explicite de liste de références. Ce sont les mêmes actions offertes par la palette de commandes d'InkyCap. Voir #wikilink("2 - Modifier des notes") pour en savoir plus sur le menu barre oblique.

#callout("tip")[ Dans l'éditeur visuel, chaque citation s'affiche comme une pastille affichant `@key`. Faites un clic droit sur une pastille et choisissez *Convertir en citation avancée* si vous voulez la forme de fonction, `#cite(<key>)`, qui accepte des options supplémentaires. Une citation sous forme de fonction porte une pastille `#` encerclé ; faites un clic droit sur cette pastille pour un groupe *Forme* où vous choisissez comment la citation se lit : *normale*, *prose*, *complète*, *auteur* ou *année*. ]

== Comment votre bibliographie apparaît

*Habituellement, vous n'avez pas à ajouter vous-même une liste de références.*

Quand vous passez en mode lecture ou générez un aperçu, InkyCap vérifie si votre note cite quelque chose de réel et, si oui, ajoute automatiquement une liste de références mise en forme à la fin (dans le style que vous avez choisi) pour que vos citations se résolvent et que la bibliographie apparaisse. Cela ne modifie pas votre fichier de note sur le disque ; cela ne se produit que dans la vue rendue.

InkyCap ne traite `@something` comme une citation que lorsque cette clé correspond réellement à une entrée de votre bibliographie. Ainsi, une adresse de courriel comme `user@domain.com` dans votre prose ne deviendra pas accidentellement une citation.

Si vous préférez contrôler exactement où se trouve la liste de références, vous pouvez écrire l'appel de bibliographie vous-même. L'entrée *Bibliographie* du menu barre oblique en insère un pour vous, pointant vers la source que vous avez choisie dans les Paramètres : le fichier qu'InkyCap génère à partir de Zotero, ou votre propre fichier de bibliographie. Avec Zotero, il ressemble à ceci :

```typ
#bibliography("/.inkycap/zotero-export.bib")
```

Si aucun fichier de bibliographie n'a encore été choisi, les guillemets sont laissés vides pour que vous les remplissiez. Vous pouvez aussi ajouter un style à cet appel :

```typ
#bibliography("/references.bib", style: "apa")
```

#callout("note")[ Le chemin commence par `/`, qu'InkyCap traite comme la racine de votre boîte de notes, de sorte que la référence fonctionne peu importe où vit la note ou comment elle est ensuite exportée. Dans Typst, la position de cet appel ne décide que *de l'endroit où la liste se rend* (par convention, à la fin) ; vos citations se résolvent à travers tout le document de toute façon. ]

#callout("tip", title: "Pour les utilisateurs de Typst")[ Si votre note a déjà un `#bibliography(...)` explicite, InkyCap le laisse en place mais ajoute votre `style:` préféré si vous n'en avez pas précisé un (sinon Typst se rabattrait sur son IEEE par défaut). Autrement, il ajoute `#bibliography("<path>", style: "<style>")` uniquement quand au moins une clé extraite existe vraiment dans votre bibliographie, ou quand la note utilise `attribution: <...>`. Les clés sans correspondance sont échappées en `\@` pour qu'elles se rendent littéralement. ]

== Copier une bibliographie seule

Parfois, vous voulez une liste de références statique et mise en forme que vous pouvez coller n'importe où (dans un courriel, un document à distribuer ou une note qui ne devrait pas dépendre d'un appel de bibliographie en direct). Quand la note courante cite au moins un ouvrage, la section *Citations* affiche un bouton *Copier la bibliographie mise en forme*. Cliquez dessus et InkyCap rend vos références citées, dans le style de citation de votre boîte de notes, comme un instantané figé sur votre presse-papiers. Collez-le dans n'importe quelle note et il se rend à l'identique, sans qu'un `#bibliography(...)` soit nécessaire.

Vous verrez « Bibliographie mise en forme copiée dans le presse-papiers » en cas de succès, ou « Aucune référence à copier » s'il n'y avait rien à copier.

#callout("warning")[ Cette fonction de copie statique fonctionne avec les sources *BibTeX* (`.bib`) et *Hayagriva YAML* (`.yml`). Les bibliographies *CSL JSON* (`.json`) peuvent être parcourues et citées, mais ne peuvent pas encore être rendues en une liste de références figée. ]

== Quand une citation a l'air d'une erreur

Si vous écrivez en *mode source*, vous pourriez remarquer que le serveur de langage signale une citation avec un message du genre « label does not exist in the document. » C'est attendu et sans danger : quand InkyCap vérifie une seule note de façon isolée, aucune bibliographie n'est encore dans la portée, alors la citation n'a rien vers quoi pointer.

InkyCap ajoute une note à cet avertissement chaque fois que la clé est une véritable entrée de bibliographie :

- *« cette citation se résout automatiquement dans l'aperçu, où la bibliographie est ajoutée pour vous »*

Autrement dit, votre citation est correcte. Elle se résoudra dès que vous prévisualiserez ou lirez la note. Un avertissement qui *ne reçoit pas* cet indice amical signifie habituellement une vraie coquille (par exemple, un renvoi vers une étiquette qui n'existe pas), ce qui vaut la peine d'être vérifié.

=== Corriger un renvoi qui n'a pas de numéro

Une référence `@` vers un titre, une figure ou une équation se rend comme le numéro de cet élément ; elle ne fonctionne donc que lorsqu'il y a un numéro à afficher. Si vous écrivez `@my-heading` dans une note qui ne numérote pas ses titres, ou pointez vers une équation qui n'est pas numérotée, Typst signale qu'il « cannot reference heading without numbering » (ou l'équivalent pour une équation). Une étiquette sur de la prose ordinaire donne « cannot reference text ». Survolez la référence soulignée et vous trouverez des correctifs en un clic :

- *Activer la numérotation des titres* ou *Activer la numérotation des équations* ajoute la règle `#set` correspondante près du haut de votre note, après le bloc de propriétés, pour que la référence ait un numéro à afficher.
- *Utiliser plutôt un lien textuel* réécrit la référence en `#link(<label>)[...]`, en utilisant les mots du titre comme texte du lien (laissés sélectionnés pour que vous puissiez les changer). Cela fonctionne que quelque chose soit numéroté ou non, et c'est le seul correctif offert pour une étiquette sur de la prose.

== Importer des notes depuis Zotero ou BibTeX

Si vos éléments Zotero ou vos entrées BibTeX portent des #highlight(fill: rgb("#ffd1e0"))[notes ou annotations] jointes, vous pouvez tirer ce texte directement dans votre écriture. Utilisez la palette de commandes `Ctrl+P` pour choisir la commande *Importer le texte d'une note depuis une référence (Zotero / BibTeX)* : cherchez une référence qui a une note jointe, puis choisissez la note pour insérer son texte clair à votre curseur. C'est une façon rapide d'amener des annotations de recherche dans votre brouillon.

== Quand vous exportez

La boîte de dialogue d'exportation comprend une case *Inclure la bibliographie dans la sortie*. Quand elle est cochée, « La bibliographie apparaîtra à la fin du document. » Quand elle est décochée, « Les citations sont résolues normalement, mais la bibliographie rendue est omise de la sortie. » C'est utile quand un éditeur fournit la liste de références séparément. Voir #wikilink("3 - Exportation et publication") pour le flux d'exportation complet, et #wikilink("2 - Collections") pour savoir comment une collection ou un livre entier gère sa bibliographie.

== Pages connexes

- #wikilink("2 - Paramètres"). L'onglet *Citations*, où vivent votre source et votre style.
- #wikilink("3 - Exportation et publication"). Les options de bibliographie quand vous exportez.
- #wikilink("2 - Collections"). Les substitutions de style par collection et les listes de références à l'échelle d'un livre.
- #wikilink("1 - Rédaction et révision"). Le contexte d'édition plus large pour insérer des citations.
