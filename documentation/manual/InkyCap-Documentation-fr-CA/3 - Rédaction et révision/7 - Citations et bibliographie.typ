#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Citations et bibliographie",
  description: "Comment connecter une bibliographie (fichier ou Zotero), parcourir et insérer des citations, choisir un style de citation, générer la liste des références, copier une bibliographie mise en forme, créer des notes de lecture et lire les avertissements de citation.",
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

#callout("note")[ Quand vous sélectionnez Zotero comme source de références, InkyCap génère son propre fichier de bibliographie à partir de votre bibliothèque Zotero (à `.inkycap/zotero-export.bib`), ce qui permet au reste de la machinerie de citation de l'application de lire cette information. Il est créé automatiquement et tenu à jour ; vous n'avez pas à le gérer. Cependant, si vous apportez des changements à une référence dans Zotero pendant que vous utilisez InkyCap, vous pouvez forcer un rafraîchissement rapide dans InkyCap en cliquant sur le bouton *Actualiser la bibliographie* en haut à droite du panneau Références. Les notes ouvertes et leur mode lecture prennent le changement en compte aussitôt. ]

== Choisir un style de citation

Le réglage *Style de citation* contrôle la mise en forme de vos citations et de votre liste de références (auteur-date, notes de bas de page, numéroté, et ainsi de suite). La valeur par défaut est *Chicago (Author-Date)*. Les styles intégrés comprennent :

- *Chicago (Author-Date)* et *Chicago (Notes)*
- *APA* et *APA (7th)*
- *MLA*
- *IEEE*
- *ACM*, *ACS*, *AIP*, *AMA*
- *Future Medicine*, *GB/T 7714 (Numeric)*

Si votre discipline ou votre éditeur a besoin d'un style absent de la liste, choisissez *Custom CSL file…* et pointez InkyCap vers un fichier de style `.csl` à l'aide de *Parcourir…*. Un style personnalisé se définit par boîte de notes et a préséance sur le style nommé global. Obtenez plus de styles auprès du #link("https://citationstyles.org/")[projet Citation Style Language].

#callout("important")[ Le style de citation que vous choisissez ici est une *valeur par défaut*. Comme le réglage lui-même le note, cela « peut être remplacé dans la sortie rendue par fichier ou par collection ». Ainsi, une boîte de notes peut être par défaut en Chicago tandis qu'une #wikilink("2 - Collections", display: "Collection") particulière est réglée pour utiliser son propre style et publie une sortie en MLA. Pour donner à une seule note son propre style, cliquez sur la pastille de sa bibliographie et choisissez-en un (voir #link(<bibliography-pill>)[Changer le titre et le style]). Un style réglé sur la bibliographie d'une note l'emporte à la fois sur votre style par défaut et sur celui d'une collection. ]

#callout("tip", title: "Pour les utilisateurs de Typst")[ InkyCap n'invente pas son propre format de citation. Il utilise les citations natives de Typst de bout en bout. Les noms de styles sont les styles CSL intégrés à Typst, et toute la mise en forme passe par hayagriva (le même moteur derrière le `#bibliography` de Typst). Le style par défaut se résout dans cet ordre : un fichier `.csl` personnalisé par boîte de notes, puis le style nommé global ; sans ni l'un ni l'autre, le style par défaut de Typst (IEEE) s'applique. Dans une exportation de collection, le style de la collection prend la place du vôtre. La sélection de source, le chemin de bibliographie et le chemin CSL personnalisé sont par boîte de notes ; le style nommé par défaut et le chemin de la base de données Zotero sont globaux. ]

== La barre latérale Références

Une fois une source configurée, ouvrez l'onglet *Références* dans le panneau de droite (son icône est un guillemet, à côté de l'onglet Liens). C'est votre base d'attache pour tout ce qui touche aux citations. Il comporte deux parties, et une troisième pour une note de lecture.

=== Parcourir les références

Cliquez sur *Parcourir les références* pour déployer la liste de chaque ouvrage de votre bibliographie. De là, vous pouvez :

- *Filtrer* la liste. Tapez dans la boîte *Filtrer les entrées…* pour faire une recherche approximative par clé, titre, auteur ou année. Encadrez votre texte de `"guillemets doubles"` pour une correspondance de phrase exacte.
- *Trier* avec le menu de tri, qui propose *Date d'ajout (récent – ancien)* (par défaut), la date d'ajout dans l'autre sens, et le titre, l'auteur ou l'année, chacun en ordre croissant ou décroissant. Votre choix est mémorisé.
- *Actualiser la bibliographie* recharge votre bibliographie (et, pour Zotero, la réexporte) pour que les ouvrages nouvellement ajoutés apparaissent.

Un petit badge vous indique combien d'entrées vous avez et si elles proviennent de *Zotero* ou d'un *Fichier*. Si certaines entrées n'ont pu être lues, vous verrez une note « ignorées » expliquant que quelques entrées avaient des erreurs de mise en forme dans la source.

*Pour insérer une citation, cliquez simplement sur une rangée.* InkyCap dépose `@key` là où votre curseur se trouve dans la note courante. Si une référence provenait de Zotero, la rangée offre aussi un lien *Ouvrir dans Zotero*. Le bouton *⋯* à droite de chaque rangée (ou un clic droit sur la rangée) ouvre les actions de #wikilink("7 - Citations et bibliographie", label: "literature-notes", display: "note de lecture") pour cette référence.

#callout("note")[ Si vous voyez « Aucune bibliographie configurée. Vérifiez Paramètres › Citations. », cela veut dire qu'InkyCap n'a pas encore trouvé de source. Retournez à l'onglet *Citations* et définissez-en une. ]

=== Citations dans ce fichier

Sous le navigateur, la section *Citations* liste chaque ouvrage cité dans la note que vous êtes en train de modifier, dédupliqué. C'est une façon rapide de voir vos sources d'un coup d'œil. Quand la note cite au moins un ouvrage, un bouton *Copier la bibliographie mise en forme* apparaît ici aussi. Il y a plus là-dessus ci-dessous. Si la note n'a pas encore sa propre bibliographie, un bouton *Insérer une bibliographie à la fin de la note* (un livre avec un signe plus) apparaît à côté et en ajoute une pour vous (voir #link(<own-bibliography>)[Ajouter votre propre bibliographie]). Chaque rangée a le même bouton *⋯* que dans la liste complète.

=== Source <references-source>

Dans une note de lecture, une section *Source* en haut de l'onglet montre l'œuvre dont traite la note, mise en forme dans votre style de citation comme elle paraîtrait dans une liste de références. Son bouton *Copier la référence mise en forme* copie cette entrée, prête à coller dans n'importe quelle note, comme *Copier la bibliographie mise en forme* le fait pour toutes les citations d'une note. Si la clé de citation de la source ne figure pas dans votre bibliographie (après une faute de frappe, ou une référence supprimée dans Zotero), la section le signale plutôt.

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

Dans l'éditeur visuel, vous n'avez pas à taper les crochets : cliquez sur la pastille de la citation et tapez la page dans son champ *Page* (voir #link(<citation-pill>)[Pastilles de citation] plus bas).

Une citation peut être collée au mot qui la précède, sans espace, comme le veulent souvent les styles à notes de bas de page (`résultats@otlet1934`). Le menu surgissant s'ouvre là aussi.

Si jamais vous devez écrire l'arobase (`@`) au début d'un mot, échappez-la d'abord avec une barre oblique inverse `\` pour qu'InkyCap ne la prenne pas pour une citation, ou choisissez *Texte brut* au bas du menu surgissant. InkyCap détecte les adresses de courriel. Quand vous terminez un mot comme `user@domain.com` et que ce qui suit le `@` n'est ni l'une de vos clés de citation ni une étiquette, l'éditeur visuel le transforme en lien de courriel (annulez pour du texte brut; voir #wikilink("4 - Liens et rétroliens")). Une adresse écrite telle quelle dans l'éditeur source n'est pas signalée comme une référence brisée et InkyCap compile toujours la note, mais les autres outils Typst ont besoin qu'elle soit liée ou écrite `user\@domain.com`.

```typ
\@notacitation
```

=== Pointer vers les titres, figures, tableaux et équations

Le même menu surgissant `@` fait plus que citer. Sous le groupe *Bibliographie*, il liste les endroits étiquetés de la note que vous écrivez, regroupés en *Titres*, *Figures*, *Équations*, *Tableaux* et *Étiquettes*. Choisissez-en un et InkyCap écrit le renvoi pour vous, sous la forme qui fonctionnera vraiment :

- Une cible qui porte un numéro (une figure, un tableau, une équation numérotée ou un titre dans une note qui numérote ses titres) est insérée comme `@label`, qui se rend comme ce numéro (par exemple, « Figure 2 »).
- Une cible sans numéro (un titre dans une note sans numérotation des titres, ou une étiquette sur de la prose ordinaire) est insérée comme lien textuel, `#link(<label>)[...]`, avec le libellé sélectionné pour que vous puissiez taper le vôtre tout de suite. Le texte gris à droite de chaque rangée vous indique quelle forme il écrira avant que vous choisissiez.

Le menu surgissant ne voit que la note dans laquelle vous êtes. Pour pointer vers un titre ou une étiquette dans une _autre_ note, utilisez plutôt un lien wiki avec `::` (voir #wikilink("4 - Liens et rétroliens")).

Pour le flux complet vu de ce côté, y compris comment écrire l'étiquette qui rend un endroit référençable au départ, voir #wikilink("4 - Liens et rétroliens", label: "liens-internes", display: "Lier à l'intérieur d'une même note").

=== Chercher des références et citer

Appuyez sur `Ctrl+Shift+C` pour ouvrir le sélecteur *Rechercher des références et citer*, une surcouche ciblée où vous pouvez chercher par clé, titre ou auteur et appuyer sur *Entrée* pour insérer la citation. C'est pratique quand vous voulez une surface de recherche plus grande que le menu surgissant en ligne.

=== Les menus barre oblique et de commandes

Tapez `/` pour la palette de commandes et choisissez *Citation* pour démarrer une citation à votre curseur, ou *Bibliographie* pour insérer un appel explicite de liste de références. Ce sont les mêmes actions offertes par la palette de commandes d'InkyCap. Voir #wikilink("2 - Modifier des notes") pour en savoir plus sur le menu barre oblique.

=== Pastilles de citation <citation-pill>

Dans l'éditeur visuel, chaque citation s'affiche comme une pastille portant sa clé, et sa page si elle en a une : `@otlet1934, p. 64`. Cliquez sur la pastille (ou faites un clic droit, ou appuyez sur *Entrée* quand elle a le focus du clavier) pour ouvrir son menu :

- *Page* reçoit une page, un chapitre ou un autre endroit de l'ouvrage, imprimé avec la citation tel que vous l'écrivez, par exemple `p. 64`, `pp. 64–70` ou `chap. 3`. Videz le champ pour l'enlever.
- *Forme* décide comment la citation se lit : *Normale*, telle que votre style de citation l'écrit, par exemple (Otlet 1934) ; *Dans le texte*, intégrée à une phrase, par exemple Otlet (1934) ; *Référence complète*, l'entrée entière telle que la bibliographie la présente ; *Auteur seulement* ; ou *Année seulement*.

Le menu offre aussi *Modifier la source*, *Copier*, *Dupliquer* et *Supprimer*, comme toute pastille. Pour modifier la citation à la main, placez le curseur dedans avec les touches fléchées.

#callout("tip", title: "Pour les utilisateurs de Typst")[ La pastille garde la forme la plus courte que Typst accepte. Une page s'écrit comme complément, `@otlet1934[p. 64]` ; choisir une forme autre que *Normale* change la citation en `#cite(<otlet1934>, form: "prose", supplement: [p. 64])`, puisque la forme `@` ne peut pas en porter. Un `#cite(...)` que vous écrivez vous-même reste un `#cite(...)`, et le menu ne change que l'argument que vous réglez. ]

== Comment votre bibliographie apparaît

*Habituellement, vous n'avez pas à ajouter vous-même une liste de références.*

Quand vous passez en mode lecture ou générez un aperçu, InkyCap vérifie si votre note cite quelque chose de réel et, si oui, ajoute automatiquement une liste de références mise en forme à la fin (dans le style que vous avez choisi) pour que vos citations se résolvent et que la bibliographie apparaisse. Cela ne modifie pas votre fichier de note sur le disque ; cela ne se produit que dans la vue rendue.

InkyCap ne traite `@something` comme une citation que lorsque cette clé correspond réellement à une entrée de votre bibliographie. Ainsi, une adresse de courriel comme `user@domain.com` dans votre prose ne deviendra pas accidentellement une citation.

=== Ajouter votre propre bibliographie <own-bibliography>

Si vous préférez contrôler exactement où se trouve la liste de références, ou lui donner son propre titre ou style, ajoutez vous-même l'appel de bibliographie à la note. Il y a deux façons de le faire :

- Dans le panneau Références, cliquez sur *Insérer une bibliographie à la fin de la note* à côté de *Citations*. Le bouton apparaît quand la note cite un ouvrage et n'a pas encore de bibliographie.
- Tapez `/` et choisissez *Bibliographie*, qui insère l'appel là où se trouve votre curseur.

Dans les deux cas, l'appel pointe vers la source que vous avez choisie dans les Paramètres : le fichier qu'InkyCap génère à partir de Zotero, ou votre propre fichier de bibliographie. Avec Zotero, il ressemble à ceci :

```typ
#bibliography("/.inkycap/zotero-export.bib")
```

Si aucun fichier de bibliographie n'a encore été choisi, les guillemets sont laissés vides pour que vous les remplissiez.

=== Changer le titre et le style <bibliography-pill>

Dans l'éditeur visuel, la bibliographie s'affiche comme une pastille. Cliquez dessus pour ouvrir son menu :

- *Titre* est le titre au-dessus de la liste. Laissez-le vide pour le titre de Typst, qui suit la langue de la note (« Bibliographie » en français). *Sans titre* imprime la liste sans titre.
- *Style de citation* commence par *Par défaut*, le style des Paramètres (ou celui de la collection quand la note est exportée avec une collection). *Choisir un style…* ouvre une liste consultable de tous les styles de citation intégrés à Typst. Cherchez par nom, par exemple `nature` ou `harvard`, et appuyez sur *Entrée*. Pour utiliser plutôt un fichier `.csl` de votre boîte de notes, tapez son chemin, terminé par `.csl`, et choisissez *Utiliser ce fichier de style de la boîte de notes*. Une fois un style réglé, le menu l'affiche avec une coche ; choisissez *Par défaut* pour revenir en arrière.

Vos choix sont écrits dans l'appel ; avec un titre et un style, il se lit ainsi :

```typ
#bibliography("/references.bib", title: [Ouvrages cités], style: "apa")
```

Le style s'applique aux citations et à la liste de références de cette note en mode lecture et dans toutes les exportations, y compris en PDF.

#callout("note")[ Le chemin commence par `/`, qu'InkyCap traite comme la racine de votre boîte de notes, de sorte que la référence fonctionne peu importe où vit la note ou comment elle est ensuite exportée. Dans Typst, la position de cet appel ne décide que *de l'endroit où la liste se rend* (par convention, à la fin) ; vos citations se résolvent à travers tout le document de toute façon. ]

#callout("tip", title: "Pour les utilisateurs de Typst")[ InkyCap donne votre style par défaut à toute bibliographie au moyen d'une règle `set` de Typst, `#set bibliography(style: "<style>")`, ajoutée juste après l'importation de la boîte de notes quand la note est compilée, pour le mode lecture comme pour toutes les exportations. Votre propre `#bibliography(...)` n'est jamais modifié : sans `style:`, il prend le style par défaut ; avec `style:`, il garde le sien ; et votre propre `#set bibliography(...)` (ou celui d'un modèle) remplace celui d'InkyCap, comme en Typst ordinaire. Sans bibliographie de votre part, InkyCap ajoute `#bibliography("<path>")` uniquement quand au moins une clé extraite existe vraiment dans votre bibliographie, ou quand la note utilise `attribution: <...>`. Les clés sans correspondance sont échappées en `\@` pour qu'elles se rendent littéralement. ]

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

== Notes de lecture <literature-notes>

Une *note de lecture* porte sur une œuvre de votre bibliographie : un article, un livre, un chapitre. Vous y notez ce qu'elle dit et ce que vous en pensez, et la note garde les détails de l'œuvre (auteur, année, revue, etc.) comme #wikilink("6 - Propriétés des notes", display: "propriétés"), de sorte qu'une #wikilink("2 - Collections", display: "collection") de vos notes de lecture peut les afficher en colonnes, triées et filtrées comme toute autre propriété.

Une note de lecture nomme son œuvre dans la propriété *source*, écrite comme vous la citeriez : `@otlet1934`. Une note qui se contente de citer de nombreuses œuvres ne reçoit pas leurs détails; seule l'œuvre nommée comme source compte.

=== Créer une note de lecture

Il y a trois façons d'en commencer une :

- Dans le panneau Références, cliquez sur le bouton *⋯* d'une référence (ou faites un clic droit dessus) et choisissez *Nouvelle note de lecture*. Cela fonctionne pour n'importe quelle référence, dans la liste complète ou parmi les citations de la note ouverte.
- Lancez *Nouvelle note de lecture à partir d'une référence* depuis la palette de commandes (`Ctrl+P`), puis cherchez la référence.
- Utilisez n'importe quel scaffold qui crée des notes de lecture, depuis une règle de création ou le sélecteur *Insérer un scaffold*. InkyCap demande d'abord de quelle référence traite la note. Si vous fermez cette question sans choisir, rien n'est créé.

La nouvelle note est nommée d'après le titre de l'œuvre (à moins que votre règle de création nomme les notes autrement, par exemple par identifiant Zettelkasten) et s'ouvre avec les détails de l'œuvre déjà remplis.

=== Le scaffold d'exemple pour les notes de lecture

InkyCap ajoute à chaque boîte de notes un scaffold appelé *literature-note-sample*, prêt à l'emploi. Il remplit le titre, la source, les auteurs, l'année, la revue ou le livre où paraît l'œuvre (sous *published-in*), l'éditeur et le DOI, étiquette la note `literature` et commence le corps par une citation et des titres pour un résumé, les idées clés, des citations et vos propres réflexions. Ouvrez-le depuis l'onglet Scaffolds du panneau des modèles pour l'adapter à votre façon de travailler, ou copiez-le pour créer plusieurs genres de notes de lecture. Si vous le supprimez, il ne revient pas. Voir #wikilink("3 - Scaffolds, Templates et Packages") pour les espaces à remplir qu'un scaffold de note de lecture peut utiliser.

Si plusieurs scaffolds créent des notes de lecture, le menu du panneau Références les énumère chacun, et la palette de commandes demande lequel utiliser.

Une fois qu'une note a une source, son onglet Références montre la référence mise en forme de cette source, avec un bouton pour la copier (voir #wikilink("7 - Citations et bibliographie", label: "references-source", display: "Source") plus haut).

=== Les détails sont une copie

Les détails de l'œuvre sont copiés dans la note au moment de sa création. Ce sont ensuite des propriétés ordinaires : vous pouvez les corriger, les compléter ou les retirer, et tout outil Typst peut les lire. Ils ne changent pas quand vous modifiez la référence dans Zotero ou dans votre fichier de bibliographie; après avoir corrigé une référence, vous voudrez donc peut-être mettre aussi à jour les notes qui en traitent.

Une propriété dont la référence n'a pas le détail est omise plutôt que laissée vide, de sorte qu'une note de lecture sur un livre n'a pas de propriété de revue.

=== Ajouter les détails à une note existante

Si vous avez commencé à écrire sur une œuvre avant d'en faire une note de lecture, ouvrez la note, appuyez sur `Ctrl+Shift+\` pour insérer un scaffold et choisissez votre scaffold de note de lecture. InkyCap demande de quelle référence traite la note, puis ajoute les détails de l'œuvre comme propriétés. Les propriétés que la note possède déjà sont conservées telles quelles, et le reste du scaffold est ajouté à la fin de la note.

Pour nommer la source d'une note sans copier de détails, cliquez sur le bouton *⋯* de la référence dans le panneau Références et choisissez *Utiliser comme source de cette note*, ou tapez `@` suivi de la clé de citation dans le champ *source* de l'onglet Propriétés.

#callout("tip", title: "Pour les utilisateurs de Typst")[La source est une étiquette Typst : `source: <otlet1934>`, la même référence que désigne `@otlet1934` (une clé qu'une étiquette ne peut pas contenir s'écrit `label("…")`). Une chaîne dans *source* reste un simple URI, comme dans les notes antérieures aux notes de lecture. Les détails sont lus dans la bibliographie avec laquelle Typst compile lui-même, de sorte que les noms des champs sont ceux de Typst (ceux de hayagriva), que vos références viennent d'un fichier ou de Zotero. L'importation Markdown lit un champ de métadonnées `citekey` comme source, et l'exportation Markdown réécrit la source sous `citekey`.]

== Quand vous exportez

La boîte de dialogue d'exportation comprend une case *Inclure la bibliographie dans la sortie*. Quand elle est cochée, « La bibliographie apparaîtra à la fin du document. » Quand elle est décochée, « Les citations sont résolues normalement, mais la bibliographie rendue est omise de la sortie. » C'est utile quand un éditeur fournit la liste de références séparément. Voir #wikilink("3 - Exportation et publication") pour le flux d'exportation complet, et #wikilink("2 - Collections") pour savoir comment une collection ou un livre entier gère sa bibliographie.

== Pages connexes

- #wikilink("2 - Paramètres"). L'onglet *Citations*, où vivent votre source et votre style.
- #wikilink("3 - Exportation et publication"). Les options de bibliographie quand vous exportez.
- #wikilink("2 - Collections"). Les substitutions de style par collection, les listes de références à l'échelle d'un livre et les vues de vos notes de lecture.
- #wikilink("3 - Scaffolds, Templates et Packages"). Les espaces à remplir qu'un scaffold de note de lecture peut utiliser.
- #wikilink("1 - Rédaction et révision"). Le contexte d'édition plus large pour insérer des citations.
